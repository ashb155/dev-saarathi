import json
import boto3
import base64
import time
import urllib.request
from datetime import datetime, timezone
from botocore.config import Config

#  Constants

REGION = "ap-south-1"
MODEL_ID = "apac.amazon.nova-pro-v1:0"
FALLBACK_MODEL_ID = "apac.amazon.nova-lite-v1:0"
KNOWLEDGE_BASE_ID = "NVPLYO2YFI"
GUARDRAIL_ID = "qn02oavrvpn2"
GUARDRAIL_VERSION = "1"
BUCKET = "dev-saarathi-bucket"
KB_MISSES_PREFIX = "knowledge_base/misses/"
RELEVANCE_THRESHOLD = 0.4

JOBS_TABLE = "dev-saarathi-jobs"
HISTORY_TABLE = "dev-saarathi-history"
USERS_TABLE = "dev-saarathi-users"

INDIAN_LANGUAGES = {
    'hi-IN': 'Hindi', 'kn-IN': 'Kannada', 'ta-IN': 'Tamil',
    'te-IN': 'Telugu', 'ml-IN': 'Malayalam', 'bn-IN': 'Bengali',
    'gu-IN': 'Gujarati', 'pa-IN': 'Punjabi', 'mr-IN': 'Marathi',
    'or-IN': 'Odia', 'en-IN': 'Indian English',
}

# -- AWS Clients

bedrock_client = boto3.client(
    "bedrock-runtime",
    config=Config(region_name=REGION, read_timeout=600)
)
bedrock_agent_client = boto3.client("bedrock-agent-runtime", region_name=REGION)
transcribe_client = boto3.client("transcribe", region_name=REGION)
s3_client = boto3.client("s3", region_name=REGION)
dynamodb = boto3.resource("dynamodb", region_name=REGION)


# -- Model Fallback Helper

def converse(messages, guardrail_config=None):
    kwargs = {"modelId": MODEL_ID, "messages": messages}
    if guardrail_config:
        kwargs["guardrailConfig"] = guardrail_config
    try:
        return bedrock_client.converse(**kwargs)
    except Exception as e:
        print(f"Nova Pro failed: {e}, falling back to Nova Lite...")
        kwargs["modelId"] = FALLBACK_MODEL_ID
        return bedrock_client.converse(**kwargs)


def get_text(response):
    return response['output']['message']['content'][0]['text']


# -- Transcription

def transcribe_audio(audio_base64, job_id, user_id=None):
    audio_bytes = base64.b64decode(audio_base64)
    s3_key = f"audio/{job_id}.wav"
    s3_client.put_object(Bucket=BUCKET, Key=s3_key, Body=audio_bytes)
    print(f"Audio uploaded: {s3_key}")

    job_name = f"transcribe-{job_id[:8]}-{int(time.time())}"
    transcribe_client.start_transcription_job(
        TranscriptionJobName=job_name,
        Media={'MediaFileUri': f"s3://{BUCKET}/{s3_key}"},
        MediaFormat='wav',
        IdentifyLanguage=True,
        LanguageOptions=list(INDIAN_LANGUAGES.keys())
    )

    while True:
        result = transcribe_client.get_transcription_job(TranscriptionJobName=job_name)
        status = result['TranscriptionJob']['TranscriptionJobStatus']
        if status == 'COMPLETED':
            detected_code = result['TranscriptionJob'].get('LanguageCode', 'en-IN')
            detected_lang = INDIAN_LANGUAGES.get(detected_code, 'Indian English')
            uri = result['TranscriptionJob']['Transcript']['TranscriptFileUri']
            with urllib.request.urlopen(uri) as r:
                data = json.loads(r.read())
                text = data['results']['transcripts'][0]['transcript']
            print(f"Transcribed: {text} ({detected_lang})")
            return text, detected_lang
        elif status == 'FAILED':
            raise Exception("Transcription failed")
        time.sleep(3)


# -- Intent Detection

def detect_intent(text):
    prompt = f"""You are an intent classifier for a developer assistant.

The developer said: "{text}"

Classify the intent into exactly one of these:
- VAANI: Developer wants to CREATE, WRITE, BUILD, or GENERATE code
- GYAAN: Developer wants to LEARN, UNDERSTAND, EXPLAIN, or know WHAT something is
- DOSH: Developer wants to DEBUG, FIX an ERROR, or troubleshoot
- KARMA: Developer wants to generate README, TESTS, handle GIT/deployment,
         OR wants to DELETE, DROP, DESTROY, WIPE, REMOVE, TRUNCATE any related destructive function

Reply with ONLY the single word: VAANI, GYAAN, DOSH, or KARMA"""

    intent = get_text(converse(messages=[{"role": "user", "content": [{"text": prompt}]}])).strip().upper()
    return intent if intent in ['VAANI', 'GYAAN', 'DOSH', 'KARMA'] else 'VAANI'


# -- KB Retrieval

def translate_query_to_english(query):
    return get_text(converse(messages=[{"role": "user", "content": [{"text":
        f"Translate this to English, return ONLY the translation nothing else: '{query}'"
    }]}])).strip()


def build_enriched_query(question, code):
    return f"{question}\n\nCode context:\n{code}"


def log_kb_miss(query):
    try:
        key = f"{KB_MISSES_PREFIX}{int(time.time())}.txt"
        s3_client.put_object(Bucket=BUCKET, Key=key, Body=query.encode('utf-8'), ContentType='text/plain')
        print(f"KB miss logged: {key}")
    except Exception as e:
        print(f"Failed to log KB miss: {e}")


def retrieve_context(query, num_results=5):
    try:
        english_query = translate_query_to_english(query)
        print(f"KB query (English): {english_query}")

        response = bedrock_agent_client.retrieve(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            retrievalQuery={'text': english_query},
            retrievalConfiguration={'vectorSearchConfiguration': {'numberOfResults': num_results}}
        )

        print("KB Retrieval Scores:")
        for i, r in enumerate(response['retrievalResults']):
            score = r.get('score', 0)
            preview = r['content']['text'][:80].replace('\n', ' ')
            print(f"  [{i+1}] Score: {score:.4f} | {preview}...")

        relevant = [r for r in response['retrievalResults'] if r.get('score', 0) >= RELEVANCE_THRESHOLD]

        if not relevant:
            print(f"No results above threshold ({RELEVANCE_THRESHOLD}), logging miss...")
            log_kb_miss(query)
            return ""

        print(f"{len(relevant)}/{len(response['retrievalResults'])} results passed threshold.")
        return '\n\n---\n\n'.join([r['content']['text'] for r in relevant])

    except Exception as e:
        print(f"KB retrieval failed: {e}")
        return ""


def extract_active_file(code_context, active_filename):
    """Extract just the active file's content from the workspace blob."""
    if not active_filename or not code_context:
        return code_context
    import re
    match = re.search(r'### FILE: [^\n]*' + re.escape(active_filename) + r'[^\n]*\n```\w*\n([\s\S]*?)```', code_context)
    return match.group(1).strip() if match else code_context


# -- VAANI

def detect_output_language(response_text):
    """Detect language from code fence and return a sensible filename."""
    import re
    match = re.search(r'```(\w+)', response_text)
    lang = match.group(1).lower() if match else 'python'
    ext_map = {
        'python': 'main.py', 'py': 'main.py',
        'javascript': 'main.js', 'js': 'main.js',
        'typescript': 'main.ts', 'ts': 'main.ts',
        'java': 'Main.java',
        'cpp': 'main.cpp', 'c++': 'main.cpp',
        'c': 'main.c',
        'go': 'main.go',
        'rust': 'main.rs',
        'bash': 'script.sh', 'sh': 'script.sh',
        'html': 'index.html',
        'css': 'style.css',
        'sql': 'query.sql',
    }
    return ext_map.get(lang, 'main.py')


def vaani_srijan(text, detected_lang, code_context=None, active_filename=None):
    print("VAANI-SRIJAN - Generating code...")

    if code_context and active_filename:
        code_context = extract_active_file(code_context, active_filename)

    if code_context:
        filename_note = f'The file you are editing is: {active_filename}. Do NOT rename or suggest a different filename.' if active_filename else ''
        prompt = f"""The developer has spoken the following in {detected_lang}: "{text}"

{filename_note}
Existing file content:
{code_context}

TASK: Add or modify the code as requested. Return the COMPLETE updated file - not just the new function.
Keep all existing code intact and insert the new code in the right place.

IMPORTANT: Format your response EXACTLY like this:

**Code:**

```python
# complete updated file here
```

**Explanation:**
<explanation here>

For the explanation, respond in {detected_lang} using ONLY bullet points and bold labels in {detected_lang} - NO markdown headers:
- **(translate "What was added" to {detected_lang}):** What exactly was added or changed, with Indian analogy
- **(translate "How it works" to {detected_lang}):** Step by step how the new code works
- **(translate "Fits with existing code" to {detected_lang}):** How it connects with the rest of the file
- **(translate "Example" to {detected_lang}):** A quick example of how to call/use the new code

RULES:
- Return the FULL file content, not just the new snippet
- The generated code MUST be complete and immediately runnable - no placeholders, no pseudocode, no TODOs
- Handle edge cases in the generated code: null/None inputs, empty collections, invalid types, boundary values
- CRITICAL: All imports/includes/requires MUST be at the very top of the file, never inside functions or classes
- Match existing code style, naming conventions, and patterns exactly
- Always use proper triple backtick fences with the correct language name
- Never write "pythonCOPY" or "bashCOPY"
- Comments inside code may be in {detected_lang}
- Explanation must be entirely in {detected_lang}"""
    else:
        prompt = f"""The developer has spoken the following in {detected_lang}: "{text}"

1. Understand their intent
2. Generate the requested code
3. Explain what the code does in simple, casual {detected_lang}

IMPORTANT: Format your response EXACTLY like this, using proper markdown code fences:

**Code:**

```python
# your code here
```

**Explanation:**
<explanation in {detected_lang} here>

RULES:
- Always use triple backtick fences (```) with the correct language name (python, javascript, java, etc.)
- The generated code MUST be complete and immediately runnable - no placeholders, no pseudocode, no TODOs
- Handle edge cases in the generated code: null/None inputs, empty collections, invalid types, boundary values
- CRITICAL: All imports/includes/requires MUST be at the very top of the file, never inside functions or classes
- Never write "pythonCOPY" or "bashCOPY" - always use proper ```language fences
- Comments inside code may be in {detected_lang}
- Explanation must be entirely in {detected_lang}"""

    return get_text(converse(messages=[{"role": "user", "content": [{"text": prompt}]}]))


# -- GYAAN

def detect_gyaan_scope(question):
    english_question = translate_query_to_english(question)
    prompt = f"""The developer asked: "{english_question}"

Classify what they want explained into ONE of:
- SNIPPET: They want a specific file, function, method, or code snippet explained. Phrases like "explain this file", "what does this do", "how does this work", "explain this code" = SNIPPET
- PROJECT: They EXPLICITLY mention the entire project, full codebase, all files, or overall architecture. Only use PROJECT if they clearly say "project", "codebase", "all files", "entire project"
- CONCEPT: They want a general concept, topic, or language feature explained with no specific code (e.g. "what is recursion", "explain async/await")

When in doubt between SNIPPET and PROJECT, always choose SNIPPET.

Reply with ONLY one word: SNIPPET, PROJECT, or CONCEPT"""
    scope = get_text(converse(messages=[{"role": "user", "content": [{"text": prompt}]}])).strip().upper()
    return scope if scope in ['SNIPPET', 'PROJECT', 'CONCEPT'] else 'CONCEPT'


def gyaan_setu(question, detected_lang, code_context=None, active_filename=None):
    print("Detecting explanation scope...")
    scope = detect_gyaan_scope(question)
    print(f"Scope: {scope}")

    code_fence_rule = "\nIMPORTANT: Always use proper triple backtick fences (```language) for any code examples. Never use 'pythonCOPY' or 'bashCOPY'.\n"

    if scope == 'SNIPPET':
        if not code_context:
            return "No code was provided."
        if active_filename and code_context:
            import re
            match = re.search(r'### FILE: [^\n]*' + re.escape(active_filename) + r'[^\n]*\n```\w*\n([\s\S]*?)```', code_context)
            snippet_context = match.group(1).strip() if match else code_context
        else:
            snippet_context = code_context
        context = retrieve_context(build_enriched_query(question, snippet_context))
        prompt = f"""You are Gyaan-Setu, a coding mentor that explains concepts in simple, casual language.
The developer speaks {detected_lang}. You MUST respond entirely in {detected_lang}.
{code_fence_rule}
Official Documentation Context:
{context if context else "Use your own knowledge."}

Developer's Code:
```
{snippet_context}
```

Developer's Question: {question}

Respond in {detected_lang} using ONLY bullet points and bold labels - NO markdown headers (no ##, no ===).
Translate ALL bold labels into {detected_lang}:
- **(translate "What it does" to {detected_lang}):** Explain what this code does in simple terms
- **(translate "How it works" to {detected_lang}):** Walk through key parts with a familiar Indian analogy
- **(translate "Important notes" to {detected_lang}):** Gotchas, edge cases, and things to watch out for
- **(translate "Practical tip" to {detected_lang}):** One actionable tip to use this better

Use ```language fences for all code examples. Respond entirely in {detected_lang}."""

    elif scope == 'PROJECT':
        if not code_context:
            return "No project code was provided."
        context = retrieve_context(build_enriched_query(question, code_context))
        prompt = f"""You are Gyaan-Setu, a coding mentor that explains projects in simple, casual language.
The developer speaks {detected_lang}. You MUST respond entirely in {detected_lang}.
{code_fence_rule}
Official Documentation Context:
{context if context else "Use your own knowledge."}

Project Code:
{code_context}

Developer's Question: {question}

IMPORTANT: Give a HIGH-LEVEL overview. Do NOT explain functions line by line. Think big picture.

Respond in {detected_lang} using ONLY bullet points and bold labels - NO markdown headers (no ##, no ===).
Translate ALL bold labels into {detected_lang}:
- **(translate "What this project does" to {detected_lang}):** 1-2 sentences on what problem this project solves
- **(translate "How it works" to {detected_lang}):** End-to-end flow explained like a story. Use a familiar Indian analogy (like a chai shop, post office, railway station etc.)
- **(translate "Main components" to {detected_lang}):** The key parts and how they connect - NO line by line function explanation
- **(translate "Try it yourself" to {detected_lang}):** One concrete example of running or using this project
- **(translate "How to improve" to {detected_lang}):** One practical suggestion to make this project better

Respond entirely in {detected_lang}."""

    else:
        context = retrieve_context(question)
        prompt = f"""You are Gyaan-Setu, a coding mentor that explains concepts in simple, casual language.
The developer speaks {detected_lang}. You MUST respond entirely in {detected_lang}.
{code_fence_rule}
Official Documentation Context:
{context if context else "Use your own knowledge."}

Developer's Question: {question}

Respond in {detected_lang} using ONLY bullet points and bold labels - NO markdown headers (no ##, no ===).
Translate ALL bold labels into {detected_lang}:
- **(translate "What it is" to {detected_lang}):** Simple one-line definition
- **(translate "How it works" to {detected_lang}):** Explain with a familiar Indian analogy
- **(translate "When to use it" to {detected_lang}):** Practical real-world scenarios
- **(translate "Example" to {detected_lang}):** A short, runnable code example if relevant
- **(translate "Practical tip" to {detected_lang}):** One key thing to remember

Use ```language fences for all code examples. Respond entirely in {detected_lang}."""

    print(f"Generating explanation in {detected_lang}...")
    return get_text(converse(messages=[{"role": "user", "content": [{"text": prompt}]}]))


# -- DOSH

def translate_message(msg, detected_lang):
    if detected_lang == "Indian English":
        return msg
    return get_text(converse(messages=[{"role": "user", "content": [{"text":
        f"Translate this to {detected_lang}, just the translation nothing else: '{msg}'"
    }]}]))


def extract_error_from_paste(pasted_text):
    lines = pasted_text.strip().splitlines()
    return {
        'code_snippet': pasted_text,
        'traceback': pasted_text,
        'error_message': lines[-1] if lines else pasted_text,
    }


def detect_dosh_scope(text):
    prompt = f"""The developer said: "{text}"

Are they asking to debug:
- FILE: They want to run and debug a specific file on disk
- SNIPPET: They have a code snippet or error traceback to paste
- LOGIC: Their code runs without errors but gives wrong or unexpected output

Reply with ONLY one word: FILE, SNIPPET, or LOGIC"""
    scope = get_text(converse(messages=[{"role": "user", "content": [{"text": prompt}]}])).strip().upper()
    return scope if scope in ['FILE', 'SNIPPET', 'LOGIC'] else 'SNIPPET'


def analyze(error_info, developer_text, detected_lang, code_context=None):
    context = retrieve_context(build_enriched_query(
        error_info.get('error_message') or developer_text,
        error_info.get('code_snippet') or ""
    ))

    project_files_section = f"\nProject Files (ALL files in workspace — use these to find missing functions, wrong import names, or mismatched definitions across files):\n{code_context}\n" if code_context else ""

    prompt = f"""You are Dosh-Drishti, a debugging mentor for Indian developers.
The developer speaks {detected_lang}. You MUST respond entirely in {detected_lang}.

IMPORTANT: Always use proper triple backtick fences (```python, ```bash etc.) for code. Never use 'pythonCOPY' or 'bashCOPY'.

Developer's Description: "{developer_text}"
Error Message: {error_info.get('error_message') or 'Not provided'}
Full Traceback: {error_info.get('traceback') or 'Not provided'}
Code: {error_info.get('code_snippet') or 'Not provided'}
{project_files_section}
Official Documentation Context: {context if context else "Use your own knowledge."}

CROSS-FILE ANALYSIS — before responding, check these:
1. ImportError or ModuleNotFoundError: scan ALL project files to find where the function/class is actually defined. Check for misspelled names, wrong file, or function never defined at all.
2. NameError or AttributeError: check ALL project files to see if the name exists anywhere and whether it needs to be imported.
3. For any import fix: show the EXACT corrected import line using the ACTUAL filename from project files (e.g. `from calculator import add, subtract` — never use placeholders).
4. If the fix requires adding a new function to another file, show the complete updated code for BOTH files.

Respond entirely in {detected_lang} using ONLY bullet points and bold labels - NO markdown headers.
Translate ALL bold labels into {detected_lang}:
- **(translate "What the problem is" to {detected_lang}):** Explain the error in simple terms with an Indian analogy
- **(translate "Why it happened" to {detected_lang}):** Root cause - what exactly triggered this error. For import errors, specify WHICH file is missing WHAT definition.
- **(translate "Step by step fix" to {detected_lang}):** Numbered steps to fix it
- **(translate "Corrected code" to {detected_lang}):** The fixed code in proper ```language fences - if import fix needed, show corrected import AND the file that needs the new/fixed function
- **(translate "How to avoid this" to {detected_lang}):** One best practice to prevent this in future"""

    return get_text(converse(messages=[{"role": "user", "content": [{"text": prompt}]}]))


def dosh_drishti(developer_text, detected_lang, code_context=None, active_filename=None):
    print("DOSH-DRISHTI - Debugging Assistant...")
    import re

    if code_context:
        terminal_match = re.search(r'### TERMINAL ERROR:\n```\n([\s\S]*?)```', code_context)
        if terminal_match:
            print("VS Code diagnostics detected — using exact Pylance/linter errors")
            error_text = terminal_match.group(1).strip()
            workspace = code_context[terminal_match.end():].strip()
            error_info = extract_error_from_paste(error_text)
            return analyze(error_info, developer_text, detected_lang, workspace)

    scope = detect_dosh_scope(developer_text)
    print(f"Scope: {scope}")

    if scope == 'FILE':
        if not code_context:
            return translate_message("No file content was provided.", detected_lang)
        active_code = extract_active_file(code_context, active_filename) if active_filename else code_context
        has_error_check = get_text(converse(messages=[{"role": "user", "content": [{"text":
            f"Does this code or text contain any errors, bugs, syntax problems, or issues that need fixing?\n\n{active_code[:3000]}\n\nReply with ONLY one word: YES or NO"
        }]}])).strip().upper()
        if has_error_check != 'YES':
            return translate_message("No errors found - the file ran without issues!", detected_lang)
        error_info = extract_error_from_paste(active_code)
        return analyze(error_info, developer_text, detected_lang, code_context)
    elif scope == 'LOGIC':
        if not code_context:
            return translate_message("No code was provided.", detected_lang)
        active_code = extract_active_file(code_context, active_filename) if active_filename else code_context
        error_info = {
            'code_snippet': active_code,
            'traceback': None,
            'error_message': "Code runs without errors but produces incorrect or unexpected output."
        }
        return analyze(error_info, developer_text, detected_lang, code_context)
    else:
        if not code_context:
            return translate_message("No code or error was provided.", detected_lang)
        error_info = extract_error_from_paste(code_context)
        return analyze(error_info, developer_text, detected_lang, code_context)


# -- KARMA

def handle_guardrail_intervention(developer_text, detected_lang):
    print("Guardrail triggered!")
    warning_prompt = f"""The developer asked: "{developer_text}"
Their language is: {detected_lang}
Translate the following safety warning into {detected_lang} naturally:
"Karma-Kavach Alert! This command is potentially dangerous and could harm your system or cloud infrastructure. For your safety, the guardrail has blocked this request. Please try a safer alternative."
Return ONLY the translated warning text."""
    try:
        return get_text(converse(messages=[{"role": "user", "content": [{"text": warning_prompt}]}]))
    except Exception:
        return "Security Alert! Request blocked by Guardrail."


def universal_safety_check(developer_text, detected_lang):
    print("Running Karma-Kavach Universal Safety Net...")
    check_prompt = f"Evaluate this developer request for destructive operations or policy violations: '{developer_text}'"
    try:
        response = converse(
            messages=[{"role": "user", "content": [{"text": check_prompt}]}],
            guardrail_config={"guardrailIdentifier": GUARDRAIL_ID, "guardrailVersion": GUARDRAIL_VERSION, "trace": "enabled"}
        )
        if response.get('stopReason') == 'guardrail_intervened':
            return False, handle_guardrail_intervention(developer_text, detected_lang)
        return True, None
    except Exception as e:
        if "blocked" in str(e).lower() or "guardrail" in str(e).lower():
            return False, handle_guardrail_intervention(developer_text, detected_lang)
        return False, f"Safety Evaluation Error: {e}"


def safe_converse(prompt, developer_text, detected_lang):
    try:
        response = converse(
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            guardrail_config={"guardrailIdentifier": GUARDRAIL_ID, "guardrailVersion": GUARDRAIL_VERSION, "trace": "enabled"}
        )
        if response.get('stopReason') == 'guardrail_intervened':
            return handle_guardrail_intervention(developer_text, detected_lang)
        return get_text(response)
    except Exception as e:
        if "blocked" in str(e).lower() or "guardrail" in str(e).lower():
            return handle_guardrail_intervention(developer_text, detected_lang)
        return f"Bedrock API Error: {e}"


def standard_converse(prompt):
    return get_text(converse(messages=[{"role": "user", "content": [{"text": prompt}]}]))


def detect_karma_task(text):
    english_text = translate_query_to_english(text)
    prompt = f"""Classify this developer request into ONE category:
- README: Developer wants to generate README or documentation
- TESTS: Developer wants to generate test cases
- GIT: Developer wants help with git commands or commit messages
- SAFETY: Developer wants to run a command that needs safety check
Developer said: "{english_text}"
Reply with ONLY one word: README, TESTS, GIT, or SAFETY"""
    task = get_text(converse(messages=[{"role": "user", "content": [{"text": prompt}]}])).strip().upper()
    return task if task in ['README', 'TESTS', 'GIT', 'SAFETY'] else 'SAFETY'


def detect_scope(text):
    english_text = translate_query_to_english(text)
    prompt = f"""The developer said: "{english_text}"
Are they asking about:
- FUNCTION: a specific function, method, class, or code snippet
- PROJECT: the entire project, full codebase, or overall README/tests
Reply with ONLY one word: FUNCTION or PROJECT"""
    scope = get_text(converse(messages=[{"role": "user", "content": [{"text": prompt}]}])).strip().upper()
    return scope if scope in ['FUNCTION', 'PROJECT'] else 'PROJECT'


CODE_FENCE_RULE = "\nIMPORTANT: Always use proper triple backtick fences (```python, ```bash, etc.) for ALL code blocks. NEVER write 'pythonCOPY', 'bashCOPY' or any similar format. Only use proper markdown.\n"


def safety_check(developer_text, detected_lang):
    prompt = f"""You are Karma-Kavach, a DevOps safety assistant for Indian developers.
The developer said: "{developer_text}"
Their language is: {detected_lang}
{CODE_FENCE_RULE}
1. Assess if this command is safe to execute.
2. Explain risks clearly in {detected_lang} and suggest a safer alternative.
Respond entirely in {detected_lang}."""
    return safe_converse(prompt, developer_text, detected_lang)


def generate_git(developer_text, detected_lang, code_context, project_structure=None, active_filename=None):
    print("Generating Git guidance...")
    structure_section = f"\nProject Structure:\n{project_structure}" if project_structure else ""
    filename_note = f"\nThe active file being committed is: {active_filename}. Use this exact filename in git add." if active_filename else ""
    prompt = f"""You are Karma-Kavach, a DevOps safety assistant.
Developer's request: "{developer_text}"
Developer's language: {detected_lang}
{CODE_FENCE_RULE}
{structure_section}{filename_note}
Code Context: {code_context if code_context else "None"}

Provide the necessary git commands and a specific commit message based on the code.
1. Respond ENTIRELY in {detected_lang}.
2. Keep English strictly to the ```bash code blocks. Everything else in {detected_lang}.
3. Keep the commit message concise but descriptive.
4. Include: git add, git commit with message, and git push if relevant."""
    return standard_converse(prompt)


def generate_project_readme(developer_text, detected_lang, project_context, project_structure):
    print("Generating project README...")
    prompt = f"""You are Karma-Kavach, a DevOps assistant.
Developer's request: "{developer_text}"
Developer's language: {detected_lang}
{CODE_FENCE_RULE}
Project Structure:\n{project_structure}\nProject Code:\n{project_context}

Generate a professional README.md based on the ACTUAL code. Include ALL of these sections:
1. Project title, then a one-line description in {detected_lang} followed by its English translation on the same line (e.g. "ಈ ಪ್ರಾಜೆಕ್ಟ್ ಒಂದು ಸರಳ ಕ್ಯಾಲ್ಕುಲೇಟರ್ — A simple calculator for basic math operations.")
2. ## Features - what the project actually does based on the code
3. ## Installation - exact steps to install dependencies and set up
4. ## Usage - concrete examples with actual function/command names from the code
5. ## Functions - list of all functions with parameters and return values (do NOT call this "API")
6. ## Examples - runnable code examples using actual functions from the project
7. ## Contributing - basic contribution guidelines

Write ALL content in English except the one-line description at the top which is bilingual.
Use proper markdown headings (##), bullet points, and ```language code fences for all code examples.
Base everything on the ACTUAL code - do not invent features that don't exist."""
    return standard_converse(prompt)


TESTS_CRITICAL_BLOCK = """CRITICAL: Before writing any test case:
1. Read the actual implementation carefully - understand what each function, method, or component does, its inputs, outputs, return types, and error conditions
2. Only assert what the code ACTUALLY does - do not assume or invent behaviour that is not in the code
3. If a function does NOT raise or throw an exception for a case, do NOT write an exception assertion for it
4. If your test code uses any external library constants or functions, import that library at the very top of the test file
5. Keep ALL imports and dependencies at the very top of the file - never inside functions, classes or test cases
6. Name each test clearly to describe exactly what is being tested (e.g. test_divide_by_zero, test_empty_list_returns_none)
7. For functions or methods returning decimals or floats, always use approximate equality assertions - never exact equality
8. Test all relevant edge cases: empty inputs, null/None/undefined, zero, negative numbers, very large inputs, duplicate values, unsorted input - whatever is relevant to the specific code
9. Test known exact expected outputs by tracing through the actual code logic manually before writing the assertion
10. For every function or method that raises or throws an exception, test both the valid path AND the error path
11. For classes, test each method independently and also test how methods interact with each other through shared state
12. For async functions or promises, use the correct async testing pattern for the framework (e.g. async/await, done callback, return promise)
13. For API endpoints, test the response status code, response body structure, and error responses
14. For UI components, test rendering, prop handling, and user interaction events
15. Do NOT test internal implementation details - only test public inputs and observable outputs
16. Make every test fully independent - no test should depend on the result or state of another test
17. Do not duplicate assertions - every test case must cover something distinct
18. Use realistic input values that reflect actual usage - not just trivial values like 1, 2, 3"""


def generate_project_tests(developer_text, detected_lang, project_context):
    print("Generating project-wide test cases...")
    prompt = f"""You are Karma-Kavach, a DevOps assistant.
Developer's request: "{developer_text}"
Developer's language: {detected_lang}
{CODE_FENCE_RULE}
Project Code:\n{project_context}

Generate comprehensive test cases for the entire project using the appropriate testing framework for the language.
The project code above contains multiple files marked as ### FILE: filename.py
For imports, use the EXACT filenames from the project code (e.g. if the file is calculator.py, use: from calculator import ...)
Do NOT use placeholder names like 'your_module' - always derive imports from the actual filenames in the project code.
Do NOT include encoding declarations like # -*- coding: utf-8 -*- at the top.
{TESTS_CRITICAL_BLOCK}
Use proper code fences for all test code.
Explain the tests in {detected_lang}."""
    return standard_converse(prompt)


def generate_function_docs(developer_text, detected_lang, user_code):
    print("Generating function documentation...")
    prompt = f"""You are Karma-Kavach, a technical documentation assistant.
Developer's request: "{developer_text}"
Developer's language: {detected_lang}
{CODE_FENCE_RULE}
Function/Code:\n```\n{user_code}\n```

Generate clear, professional documentation for this code. Include ALL of these:
1. A one-line summary of what it does
2. Parameters - name, type, description for each
3. Return value - type and description
4. Raises/Throws - any exceptions or errors it can raise
5. A concrete usage example with realistic values
6. Any important notes, gotchas, or edge cases

Write the documentation in English following the standard docstring format for the language.
Add a brief explanation in {detected_lang} at the end for the developer.
Use proper ```language fences for all code examples."""
    return standard_converse(prompt)


def generate_function_tests(developer_text, detected_lang, user_code, active_filename=None):
    print("Generating function-level tests...")
    module_name = active_filename.rsplit('.', 1)[0] if active_filename else 'your_module'
    prompt = f"""You are Karma-Kavach, a test engineer assistant.
Developer's request: "{developer_text}"
Developer's language: {detected_lang}
{CODE_FENCE_RULE}
File being tested: {active_filename or 'your_module.py'}
Code to test:\n```\n{user_code}\n```
Generate test cases for this code using the appropriate testing framework for the language.
IMPORTANT: The import MUST be: from {module_name} import <function_names>
Do NOT include encoding declarations like # -*- coding: utf-8 -*- at the top.
{TESTS_CRITICAL_BLOCK}
Use proper code fences for all test code.
Include comments explaining each test group in {detected_lang}."""
    return standard_converse(prompt)


def karma_kavach(developer_text, detected_lang, code_context=None, active_filename=None):
    print("KARMA-KAVACH - Ops Safety & Automation...")

    is_safe, warning_message = universal_safety_check(developer_text, detected_lang)
    if not is_safe:
        return f"\n{warning_message}", "SAFETY"

    task = detect_karma_task(developer_text)
    if task == "SAFETY":
        return safety_check(developer_text, detected_lang), task

    scope = detect_scope(developer_text)

    if scope == "FUNCTION":
        if not code_context:
            return "No code was provided.", task
        active_code = extract_active_file(code_context, active_filename)
        if task == "README":
            return generate_function_docs(developer_text, detected_lang, active_code), task
        elif task == "TESTS":
            return generate_function_tests(developer_text, detected_lang, active_code, active_filename), task
        elif task == "GIT":
            return generate_git(developer_text, detected_lang, active_code, None, active_filename), task
    else:  # PROJECT
        if not code_context:
            return "No project code was provided.", task
        if task == "README":
            return generate_project_readme(developer_text, detected_lang, code_context, ""), task
        elif task == "TESTS":
            return generate_project_tests(developer_text, detected_lang, code_context), task
        elif task == "GIT":
            return generate_git(developer_text, detected_lang, code_context, "", active_filename), task

    return safety_check(developer_text, detected_lang), "SAFETY"


# -- DynamoDB Helpers

def update_job(job_id, status, query, response_text, intent, detected_lang, agentic_file=None):
    expr = 'SET #s = :s, #q = :q, #r = :r, #i = :i, detected_lang = :l'
    values = {':s': status, ':q': query, ':r': response_text, ':i': intent, ':l': detected_lang}
    if agentic_file:
        expr += ', agentic_file = :af'
        values[':af'] = agentic_file
    dynamodb.Table(JOBS_TABLE).update_item(
        Key={'job_id': job_id},
        UpdateExpression=expr,
        ExpressionAttributeNames={'#s': 'status', '#q': 'query', '#r': 'response', '#i': 'intent'},
        ExpressionAttributeValues=values
    )


def save_history(user_id, query, response_text, intent, detected_lang):
    timestamp = datetime.now(timezone.utc).isoformat()
    dynamodb.Table(HISTORY_TABLE).put_item(Item={
        'user_id': user_id, 'timestamp': timestamp, 'query': query,
        'response': response_text, 'intent': intent, 'detected_lang': detected_lang
    })


def update_user_lang(user_id, detected_lang):
    try:
        dynamodb.Table(USERS_TABLE).update_item(
            Key={'user_id': user_id},
            UpdateExpression='SET preferred_lang = :l, last_seen = :ts',
            ExpressionAttributeValues={':l': detected_lang, ':ts': datetime.now(timezone.utc).isoformat()}
        )
    except Exception:
        pass


# -- Main Handler

def lambda_handler(event, context):
    job_id = event['job_id']
    user_id = event['user_id']
    audio_base64 = event['audio_base64']
    code_context = event.get('code_context')
    active_filename = event.get('active_filename')  # filename of the open file

    try:
        print(f"Processing job: {job_id}")
        text, detected_lang = transcribe_audio(audio_base64, job_id)
        intent = detect_intent(text)
        intent_override = event.get('intent_override', '')
        if intent_override in ['VAANI', 'GYAAN', 'DOSH', 'KARMA']:
            intent = intent_override
        print(f"Intent: {intent} | Lang: {detected_lang}")
        print("=" * 40)

        agentic_file = None
        if intent == 'VAANI':
            result = vaani_srijan(text, detected_lang, code_context, active_filename)
            if code_context and active_filename:
                agentic_file = active_filename
            else:
                try:
                    filename_prompt = f"Based on this code request: '{text}', suggest a single appropriate filename with extension (e.g. linked_list.py, todo_app.js). Reply with ONLY the filename, nothing else."
                    suggested = get_text(converse(messages=[{"role": "user", "content": [{"text": filename_prompt}]}])).strip()
                    agentic_file = suggested if '.' in suggested and ' ' not in suggested else detect_output_language(result)
                except Exception:
                    agentic_file = detect_output_language(result)
        elif intent == 'GYAAN':
            result = gyaan_setu(text, detected_lang, code_context, active_filename)
        elif intent == 'DOSH':
            result = dosh_drishti(text, detected_lang, code_context, active_filename)
            if active_filename:
                agentic_file = active_filename
            elif code_context:
                import re
                diag_match = re.search(r'### TERMINAL ERROR:\n```\n([^\n:]+\.\w+)', code_context)
                if diag_match:
                    agentic_file = diag_match.group(1).strip()
        elif intent == 'KARMA':
            result, task = karma_kavach(text, detected_lang, code_context, active_filename)
            if task == 'README':
                agentic_file = 'README.md'
            elif task == 'TESTS':
                if active_filename:
                    base = active_filename.rsplit('.', 1)[0]
                    agentic_file = f'test_{base}.py'
                else:
                    agentic_file = 'test_suite.py'
            elif task == 'GIT':
                agentic_file = '__GIT__'
        else:
            result = vaani_srijan(text, detected_lang, code_context)

        update_job(job_id, 'COMPLETED', text, result, intent, detected_lang, agentic_file)
        save_history(user_id, text, result, intent, detected_lang)
        update_user_lang(user_id, detected_lang)
        print(f"Job completed: {job_id}")

    except Exception as e:
        print(f"Processor error for job {job_id}: {e}")
        update_job(job_id, 'FAILED', '', str(e), '', '')