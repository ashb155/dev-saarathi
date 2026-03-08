import * as vscode from 'vscode';
import * as https from 'https';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const API_BASE = 'https://q2eaht6bo7.execute-api.ap-south-1.amazonaws.com/prod';
let pollingAborted = false;

function getUserId(): string {
    return `vscode-${vscode.env.machineId.substring(0, 16)}`;
}

function getActiveFileContent(): string | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return null; }
    return editor.document.getText();
}

async function getWorkspaceContent(): Promise<string> {
    const skipFolders = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'env', 'dist', 'build', '.idea', '.vscode', 'knowledge_base']);
    const supportedExts = new Set(['.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.rs', '.html', '.css', '.json', '.yaml', '.yml', '.toml', '.sh', '.sql']);
    const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/dist/**,**/build/**}', 50);
    let context = '';
    let totalChars = 0;
    for (const file of files) {
        const ext = file.path.substring(file.path.lastIndexOf('.'));
        if (!supportedExts.has(ext)) { continue; }
        if (file.path.split('/').some(p => skipFolders.has(p))) { continue; }
        try {
            const doc = await vscode.workspace.openTextDocument(file);
            let content = doc.getText();
            if (!content.trim()) { continue; }
            if (content.length > 5000) { content = content.substring(0, 5000) + '\n... [truncated]'; }
            const entry = '### FILE: ' + vscode.workspace.asRelativePath(file) + '\n```' + ext.slice(1) + '\n' + content + '\n```\n';
            if (totalChars + entry.length > 50000) { break; }
            context += entry;
            totalChars += entry.length;
        } catch { continue; }
    }
    return context;
}

async function recordAudioWithPython(seconds: number): Promise<string> {
    const tmpFile = path.join(os.tmpdir(), 'dev-saarathi-' + Date.now() + '.wav');
    const escapedTmp = tmpFile.replace(/\\/g, '\\\\');
    const script = [
        'import sounddevice as sd',
        'import wave',
        'import numpy as np',
        'import base64',
        'duration = ' + seconds,
        'fs = 16000',
        'recording = sd.rec(int(duration * fs), samplerate=fs, channels=1, dtype="int16")',
        'sd.wait()',
        'recording = np.clip(recording * 4, -32768, 32767).astype("int16")',
        '# Silence detection — reject if RMS volume is too low',
        'rms = np.sqrt(np.mean(recording.astype(np.float32) ** 2))',
        'if rms < 80:',
        '    print("SILENCE", flush=True)',
        '    exit(0)',
        'wf = wave.open(r"' + escapedTmp + '", "wb")',
        'wf.setnchannels(1)',
        'wf.setsampwidth(2)',
        'wf.setframerate(fs)',
        'wf.writeframes(recording.tobytes())',
        'wf.close()',
        'f = open(r"' + escapedTmp + '", "rb")',
        'print(base64.b64encode(f.read()).decode())',
        'f.close()',
    ].join('\n');

    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('python', ['-c', script]);
        let output = '';
        let error = '';
        proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { error += d.toString(); });
        proc.on('close', (code: number) => {
            try { fs.unlinkSync(tmpFile); } catch { }
            if (code === 0 && output.trim() === 'SILENCE') { reject(new Error('SILENCE')); }
            else if (code === 0 && output.trim()) { resolve(output.trim()); }
            else { reject(new Error(error || 'Recording failed')); }
        });
    });
}

function httpsPost(url: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const req = https.request({
            hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                } else {
                    resolve(data);
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function httpsGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                } else {
                    resolve(data);
                }
            });
        }).on('error', reject);
    });
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function pollWithBackoff(jobId: string, maxAttempts = 50): Promise<{
    status: string; query?: string; response?: string; intent?: string;
    detected_lang?: string; error?: string; agentic_file?: string;
}> {
    const getDelay = (attempt: number) => attempt < 6 ? 3000 : attempt < 12 ? 5000 : 8000;
    for (let i = 0; i < maxAttempts; i++) {
        await sleep(getDelay(i));
        if (pollingAborted) { throw new Error('ABORTED'); }
        const raw = await httpsGet(API_BASE + '/result/' + jobId);
        const data = JSON.parse(raw);
        if (data.status === 'COMPLETED' || data.status === 'FAILED') { return data; }
    }
    throw new Error('TIMEOUT');
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new DevSaarathiViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('devSaarathi.chatView', provider));
    context.subscriptions.push(vscode.commands.registerCommand('dev-saarathi.start', () => {
        vscode.commands.executeCommand('devSaarathi.chatView.focus');
    }));
}

class DevSaarathiViewProvider implements vscode.WebviewViewProvider {
    constructor(private readonly extensionUri: vscode.Uri) { }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = getWebviewContent();

        const updateContext = async () => {
            const editor = vscode.window.activeTextEditor;
            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 5);
            const isProject = files.length > 1;
            const label = isProject
                ? (editor ? path.basename(editor.document.fileName) + ' + project' : 'Project')
                : (editor ? path.basename(editor.document.fileName) : 'No file open');
            webviewView.webview.postMessage({ command: 'context', filename: label });
        };
        updateContext();
        const editorListener = vscode.window.onDidChangeActiveTextEditor(updateContext);
        webviewView.onDidDispose(() => editorListener.dispose());

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'startRecording') {
                await handleRecording(webviewView.webview, message.seconds || 7);
            } else if (message.command === 'getHistory') {
                await loadHistory(webviewView.webview);
            } else if (message.command === 'acceptAction') {
                await executeAgenticAction(message.intent, message.content, message.agentic_file);
                webviewView.webview.postMessage({ command: 'actionDone', id: message.id });
            } else if (message.command === 'rejectAction') {
                webviewView.webview.postMessage({ command: 'actionDone', id: message.id });
            } else if (message.command === 'cancelPolling') {
                pollingAborted = true;
            }
        });
    }
}

function extractCleanCode(content: string): string {
    const firstFence = content.indexOf('```');
    const afterOpen = firstFence > -1 ? firstFence + 3 : -1;
    const closeFence = afterOpen > -1 ? content.indexOf('```', afterOpen) : -1;
    let cleanCode = (afterOpen > -1 && closeFence > afterOpen)
        ? content.substring(afterOpen, closeFence)
        : content;
    cleanCode = cleanCode.replace(/COPY$/gm, '');
    cleanCode = cleanCode.replace(/^[a-zA-Z]+\n/, ''); 
    cleanCode = cleanCode.replace(/^(?:python|javascript|js|typescript|ts|bash|java|go|rust|cpp|c|sql|html|css)(?=[a-zA-Z\/\-#])/, '');  // fused: "pythonfrom"
    return cleanCode.trim();
}

async function executeAgenticAction(intent: string, content: string, agenticFile?: string) {
    if (intent === 'VAANI' && agenticFile) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { vscode.window.showErrorMessage('No workspace folder open!'); return; }
        const root = workspaceFolders[0].uri;
        const cleanCode = extractCleanCode(content);
        const fileUri = vscode.Uri.joinPath(root, agenticFile);
        let fileExists = false;
        try { await vscode.workspace.fs.stat(fileUri); fileExists = true; } catch { }
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(cleanCode));
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        const msg = fileExists ? '✅ Dev-Saarathi updated ' + agenticFile : '✨ Dev-Saarathi created ' + agenticFile;
        vscode.window.showInformationMessage(msg);
        return;
    }


    if (intent === 'DOSH' && agenticFile) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { vscode.window.showErrorMessage('No workspace folder open!'); return; }
        const root = workspaceFolders[0].uri;
        const cleanCode = extractCleanCode(content);
        const fileUri = vscode.Uri.joinPath(root, agenticFile);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length)
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(fileUri, fullRange, cleanCode);
        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage('🔧 Dev-Saarathi applied fix to ' + agenticFile);
        return;
    }

    if (agenticFile === '__GIT__') {
        const terminal = vscode.window.createTerminal('Dev-Saarathi Git');
        terminal.show();
        terminal.sendText('# Suggested by Dev-Saarathi — review and press Enter to run:');
        const bashMatch = content.match(/```bash\n([\s\S]*?)```/);
        if (bashMatch) {
            bashMatch[1].trim().split('\n').forEach(line => terminal.sendText(line, false));
        }
        vscode.window.showInformationMessage('🚀 Dev-Saarathi: Git commands ready in terminal — review and run!');
        return;
    }


    if (agenticFile) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { vscode.window.showErrorMessage('No workspace folder open!'); return; }
        const root = workspaceFolders[0].uri;
        const isTest = agenticFile.startsWith('test_') || agenticFile === 'test_suite.py';
        let cleanContent: string;
        if (isTest) {
            const codeMatch = content.match(/```(?:\w+)?\n([\s\S]*?)```/);
            cleanContent = codeMatch ? codeMatch[1].trim() : content.trim();
        } else {
            const firstHeading = content.indexOf('\n#');
            cleanContent = firstHeading > 0 ? content.slice(firstHeading + 1).trim() : content.trim();
        }
        const fileUri = vscode.Uri.joinPath(root, agenticFile);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(cleanContent));
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage('✅ Dev-Saarathi created ' + agenticFile);
    }
}

function getActiveDiagnostics(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return ''; }
    const uri = editor.document.uri;
    const diags = vscode.languages.getDiagnostics(uri);
    if (!diags || diags.length === 0) { return ''; }
    const relevant = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);
    if (relevant.length === 0) { return ''; }
    const filename = path.basename(editor.document.fileName);
    const lines = relevant.map(d => {
        const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
        return filename + ':' + (d.range.start.line + 1) + ':' + (d.range.start.character + 1) + ': ' + severity + ': ' + d.message;
    });
    return lines.join('\n');
}

async function handleRecording(webview: vscode.Webview, seconds: number) {
    const userId = getUserId();
    pollingAborted = false;
    try {
        webview.postMessage({ command: 'status', text: 'Recording for ' + seconds + 's... Speak now!' });
        const audioBase64 = await recordAudioWithPython(seconds);
        if (pollingAborted) { webview.postMessage({ command: 'error', text: 'Request cancelled.' }); return; }
        const codeContext = getActiveFileContent();
        const workspaceContext = await getWorkspaceContent();
        webview.postMessage({ command: 'status', text: 'Transcribing your voice...' });
        const body: Record<string, string> = { audio: audioBase64, user_id: userId };
        const activeEditor = vscode.window.activeTextEditor;
        if (workspaceContext) { body.code_context = workspaceContext; }
        else if (codeContext) { body.code_context = codeContext; }
        if (activeEditor) { body.active_filename = path.basename(activeEditor.document.fileName); }
        const diagnostics = getActiveDiagnostics();
        if (diagnostics && body.code_context) {
            body.code_context = '### TERMINAL ERROR:\n```\n' + diagnostics + '\n```\n' + body.code_context;
        }
        let bodyStr = JSON.stringify(body);
        if (bodyStr.length > 200000 && body.code_context) {
            body.code_context = body.code_context.substring(0, Math.max(1000, body.code_context.length - (bodyStr.length - 200000) - 200));
            bodyStr = JSON.stringify(body);
        }
        const triggerRaw = await httpsPost(API_BASE + '/voice', bodyStr);
        const triggerData = JSON.parse(triggerRaw) as { job_id?: string; error?: string };
        if (!triggerData.job_id) { webview.postMessage({ command: 'error', text: triggerData.error || 'Failed to start job' }); return; }

        webview.postMessage({ command: 'status', text: 'Processing with Dev-Saarathi AI...' });

        let resultData: { status: string; query?: string; response?: string; intent?: string; detected_lang?: string; error?: string; agentic_file?: string; };
        try {
            resultData = await pollWithBackoff(triggerData.job_id);
        } catch (pollErr) {
            const msg = String(pollErr);
            if (msg === 'Error: ABORTED') { webview.postMessage({ command: 'error', text: 'Request cancelled.' }); }
            else if (msg === 'Error: TIMEOUT') { webview.postMessage({ command: 'error', text: 'Request timed out — please try again.' }); }
            else { webview.postMessage({ command: 'error', text: msg }); }
            return;
        }

        if (resultData.status === 'COMPLETED') {
            const intent = resultData.intent || '';
            const isAgentic = !!(intent === 'VAANI' && resultData.agentic_file)
                || !!(intent === 'DOSH' && resultData.agentic_file)
                || !!(intent === 'KARMA' && resultData.agentic_file);
            webview.postMessage({
                command: 'response',
                query: resultData.query,
                response: resultData.response,
                intent: intent,
                detected_lang: resultData.detected_lang,
                agentic: isAgentic,
                agentic_file: resultData.agentic_file || null
            });
        } else {
            webview.postMessage({ command: 'error', text: resultData.error || 'Processing failed' });
        }

    } catch (err) {
        const msg = String(err);
        if (msg.includes('SILENCE')) {
            webview.postMessage({ command: 'error', text: 'No audio detected — please speak clearly and try again!' });
        } else if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|socket hang up/i.test(msg)) {
            webview.postMessage({ command: 'error', text: '🔌 Backend unavailable — check your internet connection and try again.' });
        } else {
            webview.postMessage({ command: 'error', text: msg });
        }
    }
}

async function loadHistory(webview: vscode.Webview) {
    try {
        const raw = await httpsGet(API_BASE + '/history/' + getUserId());
        webview.postMessage({ command: 'history', data: JSON.parse(raw) });
    } catch (err) { console.error('Failed to load history:', err); }
}

function getWebviewContent(): string {
    const js = buildJS();
    const css = buildCSS();
    const html = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src https://fonts.gstatic.com; script-src \'unsafe-inline\' https://cdnjs.cloudflare.com; img-src data:;">',
        '<title>Dev-Saarathi</title>',
        "<style>@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;800&family=JetBrains+Mono:wght@400;500&display=swap');</style>",
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"></script>',
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>',
        '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">',
        '<style>' + css + '</style>',
        '</head>',
        '<body>',
        '<div class="header"><span class="logo">DEV-SAARATHI</span><span class="tagline">Voice · AI · India</span></div>',
        '<div class="chat" id="chat">',
        '  <div class="welcome" id="welcome">',
        '    <div class="welcome-icon">&#127908;</div>',
        '    <h2>Namaste, Developer!</h2>',
        '    <p>Speak in your language. I understand code in any Indian language.</p>',
        '    <div class="lang-pills">',
        '      <span class="lang-pill">&#2361;&#2367;&#2306;&#2342;&#2368;</span>',
        '      <span class="lang-pill">&#2980;&#2990;&#3007;&#2996;&#3021;</span>',
        '      <span class="lang-pill">&#3108;&#3142;&#3122;&#3137;&#3095;&#3137;</span>',
        '      <span class="lang-pill">&#3221;&#3240;&#3277;&#3240;&#3233;</span>',
        '      <span class="lang-pill">English</span>',
        '    </div>',
        '  </div>',
        '</div>',
        '<div class="controls">',
        '  <div id="ctxBar" class="ctx-bar"><div class="ctx-dot"></div><span id="ctxLabel">No file open</span></div>',
        '  <div class="duration-row">',
        '    <button class="dur-btn active" id="dur5" onclick="setDuration(5)">5s</button>',
        '    <button class="dur-btn" id="dur7" onclick="setDuration(7)">7s</button>',
        '    <button class="dur-btn" id="dur10" onclick="setDuration(10)">10s</button>',
        '    <button class="dur-btn" id="dur15" onclick="setDuration(15)">15s</button>',
        '  </div>',
        '  <div class="countdown" id="countdown"></div>',
        '  <button class="mic-btn" id="micBtn" onclick="startRecording()">&#127908; Speak Now</button>',
        '  <button class="cancel-btn" id="cancelBtn" onclick="cancelPolling()" style="display:none;">✕ Cancel</button>',
        '  <div class="hint">Speak in Hindi, Tamil, Telugu, Kannada &amp; more</div>',
        '</div>',
        '<script>' + js + '</' + 'script>',
        '</body>',
        '</html>'
    ].join('\n');
    return html;
}

function buildCSS(): string {
    return [
        '* { margin: 0; padding: 0; box-sizing: border-box; }',
        ':root { --bg: #0d0d0f; --surface: #141418; --border: #1e1e24; --accent: #ff6b35; --accent2: #ffd166; --text: #e8e8f0; --muted: #6b6b7e; --vaani: #4ecdc4; --gyaan: #a29bfe; --dosh: #fd79a8; }',
        'body { font-family: "Syne", sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }',
        '.header { padding: 14px 16px 10px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; background: var(--surface); }',
        '.logo { font-size: 15px; font-weight: 800; letter-spacing: -0.5px; background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }',
        '.tagline { font-size: 9px; color: var(--muted); letter-spacing: 1.5px; text-transform: uppercase; margin-left: auto; }',
        '.chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }',
        '.welcome { text-align: center; padding: 24px 16px; display: flex; flex-direction: column; align-items: center; gap: 12px; }',
        '.welcome-icon { font-size: 36px; animation: pulse 2s ease-in-out infinite; }',
        '@keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }',
        '.welcome h2 { font-size: 16px; font-weight: 800; }',
        '.welcome p { font-size: 11px; color: var(--muted); line-height: 1.6; max-width: 200px; }',
        '.lang-pills { display: flex; flex-wrap: wrap; gap: 5px; justify-content: center; margin-top: 4px; }',
        '.lang-pill { font-size: 9px; padding: 3px 8px; border-radius: 20px; border: 1px solid var(--border); color: var(--muted); }',
        '.msg { display: flex; flex-direction: column; gap: 6px; animation: slideIn 0.3s ease; }',
        '@keyframes slideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }',
        '.msg-meta { display: flex; align-items: center; gap: 6px; }',
        '.intent-badge { font-size: 8px; font-weight: 600; padding: 2px 7px; border-radius: 20px; letter-spacing: 1px; text-transform: uppercase; }',
        '.badge-VAANI { background: rgba(78,205,196,0.15); color: var(--vaani); border: 1px solid rgba(78,205,196,0.3); }',
        '.badge-GYAAN { background: rgba(162,155,254,0.15); color: var(--gyaan); border: 1px solid rgba(162,155,254,0.3); }',
        '.badge-DOSH { background: rgba(253,121,168,0.15); color: var(--dosh); border: 1px solid rgba(253,121,168,0.3); }',
        '.badge-KARMA { background: rgba(255,234,167,0.15); color: #c9a227; border: 1px solid rgba(255,234,167,0.3); }',
        '.msg-lang { font-size: 9px; color: var(--muted); margin-left: auto; }',
        '.msg-query { font-size: 11px; color: var(--muted); font-style: italic; padding-left: 2px; }',
        '.msg-response { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; font-size: 12px; line-height: 1.8; color: var(--text); word-break: break-word; font-family: "JetBrains Mono", monospace; }',
        '.msg-response p { margin-bottom: 8px; }',
        '.msg-response p:last-child { margin-bottom: 0; }',
        '.msg-response strong { color: var(--accent2); font-weight: 600; }',
        '.msg-response em { color: var(--muted); }',
        '.msg-response h1, .msg-response h2, .msg-response h3 { color: var(--accent2); margin: 10px 0 6px; font-size: 13px; font-weight: 700; }',
        '.msg-response ul, .msg-response ol { padding-left: 16px; margin: 6px 0; }',
        '.msg-response li { margin: 3px 0; font-size: 12px; }',
        '.msg-response blockquote { border-left: 2px solid var(--accent); padding-left: 10px; color: var(--muted); margin: 6px 0; }',
        '.msg-response hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }',
        '.msg-response pre { background: #0a0a0c !important; border: 1px solid var(--border); border-radius: 6px; margin: 8px 0; overflow-x: auto; position: relative; }',
        '.msg-response pre code { font-family: "JetBrains Mono", monospace !important; font-size: 11px !important; line-height: 1.6; padding: 32px 12px 12px !important; display: block; background: transparent !important; }',
        '.msg-response code:not(pre code) { font-family: "JetBrains Mono", monospace; font-size: 11px; background: rgba(255,107,53,0.1); color: var(--accent); padding: 1px 5px; border-radius: 3px; }',
        '.copy-btn { position: absolute; top: 6px; right: 6px; background: var(--border); border: none; color: var(--muted); font-size: 9px; padding: 3px 7px; border-radius: 4px; cursor: pointer; transition: all 0.15s; letter-spacing: 0.5px; }',
        '.copy-btn:hover { background: var(--accent); color: white; }',
        '.inline-code { font-family: "JetBrains Mono", monospace; font-size: 11px; background: rgba(255,107,53,0.1); color: var(--accent); padding: 1px 5px; border-radius: 3px; }',
        '.code-lang { position: absolute; top: 6px; left: 10px; font-size: 9px; color: var(--muted); font-family: "JetBrains Mono", monospace; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }',
        '.status { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted); padding: 8px 12px; background: var(--surface); border-radius: 8px; border: 1px solid var(--border); animation: slideIn 0.3s ease; }',
        '.spinner { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }',
        '@keyframes spin { to { transform: rotate(360deg); } }',
        '.error-msg { font-size: 11px; color: var(--dosh); padding: 8px 12px; background: rgba(253,121,168,0.08); border: 1px solid rgba(253,121,168,0.2); border-radius: 8px; }',
        '.guardrail-warn { background: rgba(255,214,102,0.07); border: 1px solid rgba(255,214,102,0.3); border-left: 3px solid var(--accent2); border-radius: 8px; padding: 10px 14px; }',
        '.guardrail-warn::before { content: "⚠️ कर्म-कवच — Request Blocked"; display: block; font-size: 9px; font-weight: 700; color: var(--accent2); letter-spacing: 1px; margin-bottom: 8px; text-transform: uppercase; }',
        '.action-bar { display: flex; gap: 6px; margin-top: 8px; }',
        '.action-label { font-size: 9px; color: var(--muted); margin-bottom: 4px; letter-spacing: 0.5px; }',
        '.btn-accept { flex: 1; padding: 7px; border-radius: 6px; background: rgba(78,205,196,0.15); color: var(--vaani); font-size: 10px; font-weight: 700; cursor: pointer; border: 1px solid rgba(78,205,196,0.3); transition: all 0.15s; }',
        '.btn-accept:hover { background: rgba(78,205,196,0.3); }',
        '.btn-reject { flex: 1; padding: 7px; border-radius: 6px; background: rgba(253,121,168,0.1); color: var(--dosh); font-size: 10px; font-weight: 700; cursor: pointer; border: 1px solid rgba(253,121,168,0.2); transition: all 0.15s; }',
        '.btn-reject:hover { background: rgba(253,121,168,0.25); }',
        '.action-done { font-size: 10px; color: var(--muted); text-align: center; margin-top: 6px; font-style: italic; }',
        '.controls { padding: 12px 16px; border-top: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; gap: 8px; }',
        '.duration-row { display: flex; gap: 6px; }',
        '.dur-btn { flex: 1; padding: 6px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--muted); font-size: 10px; cursor: pointer; transition: all 0.15s; }',
        '.dur-btn.active { background: rgba(255,107,53,0.15); color: var(--accent); border-color: rgba(255,107,53,0.4); }',
        '.dur-btn:hover { border-color: var(--accent); color: var(--accent); }',
        '.mic-btn { width: 100%; padding: 12px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 700; letter-spacing: 0.5px; transition: all 0.2s ease; background: linear-gradient(135deg, var(--accent), #e85d04); color: white; display: flex; align-items: center; justify-content: center; gap: 8px; }',
        '.mic-btn:hover { transform: translateY(-1px); filter: brightness(1.1); }',
        '.mic-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }',
        '.hint { font-size: 9px; color: var(--muted); text-align: center; letter-spacing: 0.5px; }',
        '.cancel-btn { width: 100%; padding: 8px; border-radius: 6px; border: 1px solid rgba(253,121,168,0.3); background: rgba(253,121,168,0.1); color: var(--dosh); font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s; }',
        '.cancel-btn:hover { background: rgba(253,121,168,0.25); }',
        '.countdown { font-size: 11px; color: var(--accent); text-align: center; font-family: "JetBrains Mono", monospace; display: none; }',
        '.ctx-bar { font-size: 9px; color: var(--muted); padding: 4px 8px; background: rgba(78,205,196,0.05); border: 1px solid rgba(78,205,196,0.1); border-radius: 4px; display: none; align-items: center; gap: 5px; }',
        '.ctx-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--vaani); flex-shrink: 0; }',
    ].join('\n');
}

function buildJS(): string {
    return [
        'var vscode = acquireVsCodeApi();',
        'var selectedDuration = 5;',
        'var countdownInterval = null;',
        'var actionCounter = 0;',
        'var pendingActions = {};',
        '',
        'var markedRenderer = new marked.Renderer();',
        'markedRenderer.code = function(obj) {',
        '  var code = typeof obj === "string" ? obj : (obj.text || "");',
        '  var lang = typeof obj === "string" ? arguments[1] : (obj.lang || "");',
        '  var language = (lang && hljs.getLanguage(lang)) ? lang : "plaintext";',
        '  var highlighted = hljs.highlight(code, { language: language }).value;',
        '  var langLabel = lang ? "<span class=\\"code-lang\\">"+lang+"</span>" : "";',
        '  return "<pre>"+langLabel+"<code class=\\"hljs language-"+language+"\\">"+highlighted+"</code></pre>";',
        '};',
        'marked.use({ renderer: markedRenderer, breaks: true, gfm: true });',
        '',
        'function renderMarkdown(text) {',
        '  var TICK = String.fromCharCode(96);',
        '  var FENCE = TICK+TICK+TICK;',
        '  text = text.replace(/([a-zA-Z]+)COPY`([^`]+)`/g, function(_, lang, code) { return FENCE + lang + "\\n" + code.trim() + "\\n" + FENCE; });',
        '  // Strip bare COPY suffix appended to code lines',
        '  text = text.replace(/COPY$/gm, "");',
        '  // Strip ```markdown wrapper if LLM wraps entire response in a code fence',
        '  var mdFence = new RegExp("^" + FENCE + "markdown\\\\n([\\\\s\\\\S]*?)\\\\n?" + FENCE + "$", "m");',
        '  var mdMatch = text.trim().match(mdFence);',
        '  if (mdMatch) { text = mdMatch[1]; }',
        '  return marked.parse(text);',
        '}',
        '',
        'function copyCode(btn) {',
        '  var code = btn.previousElementSibling ? btn.previousElementSibling.innerText : btn.closest("pre").querySelector("code").innerText;',
        '  navigator.clipboard.writeText(code);',
        '  btn.textContent = "COPIED!";',
        '  setTimeout(function(){ btn.textContent = "COPY"; }, 2000);',
        '}',
        '',
        'function setDuration(s) {',
        '  selectedDuration = s;',
        '  document.querySelectorAll(".dur-btn").forEach(function(b){ b.classList.remove("active"); });',
        '  document.getElementById("dur"+s).classList.add("active");',
        '}',
        '',
        'function startRecording() {',
        '  var btn = document.getElementById("micBtn");',
        '  btn.disabled = true;',
        '  btn.textContent = "Recording...";',
        '  var remaining = selectedDuration;',
        '  var cd = document.getElementById("countdown");',
        '  cd.style.display = "block";',
        '  cd.textContent = remaining+"s remaining";',
        '  countdownInterval = setInterval(function(){',
        '    remaining--;',
        '    cd.textContent = remaining+"s remaining";',
        '    if (remaining <= 0) {',
        '      clearInterval(countdownInterval);',
        '      cd.style.display = "none";',
        '      btn.textContent = "Processing...";',
        '    }',
        '  }, 1000);',
        '  vscode.postMessage({ command: "startRecording", seconds: selectedDuration });',
        '  document.getElementById("cancelBtn").style.display = "block";',
        '}',
        '',
        'function resetBtn() {',
        '  var btn = document.getElementById("micBtn");',
        '  btn.disabled = false;',
        '  btn.textContent = "\\uD83C\\uDF99 Speak Now";',
        '  clearInterval(countdownInterval);',
        '  document.getElementById("countdown").style.display = "none";',
        '  document.getElementById("cancelBtn").style.display = "none";',
        '}',
        '',
        'function cancelPolling() {',
        '  vscode.postMessage({ command: "cancelPolling" });',
        '  resetBtn();',
        '}',
        '',
        'function hideWelcome() {',
        '  var w = document.getElementById("welcome");',
        '  if (w) { w.remove(); }',
        '}',
        '',
        'function addStatus(text) {',
        '  removeStatus();',
        '  var el = document.createElement("div");',
        '  el.className = "status"; el.id = "statusMsg";',
        '  el.innerHTML = "<div class=\\"spinner\\"></div><span>"+text+"</span>";',
        '  document.getElementById("chat").appendChild(el);',
        '  scrollToBottom();',
        '}',
        '',
        'function removeStatus() {',
        '  var el = document.getElementById("statusMsg");',
        '  if (el) { el.remove(); }',
        '}',
        '',
        'function addError(text) {',
        '  removeStatus();',
        '  if (!text) { resetBtn(); return; }',
        '  var el = document.createElement("div");',
        '  el.className = "error-msg";',
        '  el.textContent = "⚠️ "+text;',
        '  document.getElementById("chat").appendChild(el);',
        '  scrollToBottom();',
        '}',
        '',
        'function getActionLabel(intent, content, agenticFile) {',
        '  var fname = agenticFile || "file";',
        '  if (intent === "VAANI") { return fname.indexOf(".") > 0 ? "\u270f\ufe0f Save to " + fname + "?" : "\u270f\ufe0f Write changes to file?"; }',
        '  if (intent === "DOSH") { return "\uD83D\uDD27 Apply fix to " + fname + "?"; }',
        '  if (agenticFile === "__GIT__") { return "\\uD83D\\uDE80 Open git commands in terminal?"; }',
        '  if (agenticFile === "README.md") { return "\\uD83D\\uDCC4 Create README.md in workspace?"; }',
        '  if (agenticFile && agenticFile.indexOf("test") === 0) { return "\\uD83E\\uDDEA Create " + agenticFile + " in workspace?"; }',
        '  return "\\uD83D\\uDCBE Save output to file?";',
        '}',
        '',
        'function acceptAction(actionId) {',
        '  var data = pendingActions[actionId];',
        '  if (!data) { return; }',
        '  vscode.postMessage({ command: "acceptAction", id: actionId, intent: data.intent, content: data.content, agentic_file: data.agentic_file || null });',
        '  delete pendingActions[actionId];',
        '}',
        '',
        'function rejectAction(actionId) {',
        '  vscode.postMessage({ command: "rejectAction", id: actionId });',
        '  delete pendingActions[actionId];',
        '}',
        '',
        'function isGuardrailResponse(text) {',
        '  if (!text) { return false; }',
        '  return text.includes("कर्म-कवच") || text.includes("Karma-Kavach Alert") ||',
        '    text.includes("karma-kavach") || text.includes("ಕರ್ಮ-ಕವಚ") ||',
        '    text.includes("கர்ம-கவசம்") || text.includes("కర్మ-కవచం") ||',
        '    /blocked.*request|request.*blocked/i.test(text);',
        '}',
        '',
        'function addResponse(msg) {',
        '  var emojis = { VAANI: "⚡", GYAAN: "📚", DOSH: "🔍", KARMA: "🛡️" };',
        '  var intent = msg.intent || "VAANI";',
        '  var rendered = renderMarkdown(msg.response || "");',
        '  var el = document.createElement("div");',
        '  el.className = "msg";',
        '  var actionId = "act-"+(actionCounter++);',
        '  if (msg.agentic) {',
        '    pendingActions[actionId] = { intent: intent, content: msg.response || "", agentic_file: msg.agentic_file || null };',
        '  }',
        '  var agenticHtml = "";',
        '  if (msg.agentic) {',
        '    agenticHtml = "<div class=\\"action-label\\">"+getActionLabel(intent, msg.response, msg.agentic_file)+"</div>"',
        '      + "<div class=\\"action-bar\\" id=\\"action-"+actionId+"\\">"',
        '      + "<button class=\\"btn-accept\\" onclick=\\"acceptAction(\'"+actionId+"\')\\" >✓ Accept</button>"',
        '      + "<button class=\\"btn-reject\\" onclick=\\"rejectAction(\'"+actionId+"\')\\" >✕ Reject</button>"',
        '      + "</div>";',
        '  }',
        '  var metaHtml = "<div class=\\"msg-meta\\">"',
        '    + "<span class=\\"intent-badge badge-"+intent+"\\">"+(emojis[intent]||"🤖")+" "+intent+"</span>"',
        '    + "<span class=\\"msg-lang\\">"+(msg.detected_lang||"")+"</span>"',
        '    + "</div>";',
        '  var queryHtml = msg.query ? "<div class=\\"msg-query\\">\\""+msg.query+"\\"</div>" : "";',
        '  var cls = isGuardrailResponse(msg.response) ? "msg-response guardrail-warn" : "msg-response";',
        '  el.innerHTML = metaHtml + queryHtml + "<div class=\\"" + cls + "\\">"+rendered+"</div>" + agenticHtml;',
        '  el.querySelectorAll("pre").forEach(function(pre) {',
        '    pre.style.position = "relative";',
        '    var btn = document.createElement("button");',
        '    btn.className = "copy-btn";',
        '    btn.textContent = "COPY";',
        '    btn.onclick = function() {',
        '      var code = pre.querySelector("code");',
        '      navigator.clipboard.writeText(code ? code.innerText : "");',
        '      btn.textContent = "COPIED!";',
        '      setTimeout(function(){ btn.textContent = "COPY"; }, 2000);',
        '    };',
        '    pre.appendChild(btn);',
        '  });',
        '  document.getElementById("chat").appendChild(el);',
        '  scrollToBottom();',
        '}',
        '',
        'function scrollToBottom() {',
        '  var c = document.getElementById("chat");',
        '  c.scrollTop = c.scrollHeight;',
        '}',
        '',
        'window.addEventListener("message", function(event) {',
        '  var msg = event.data;',
        '  if (msg.command === "status") {',
        '    removeStatus(); addStatus(msg.text);',
        '  } else if (msg.command === "response") {',
        '    removeStatus(); hideWelcome(); addResponse(msg); resetBtn();',
        '  } else if (msg.command === "error") {',
        '    removeStatus(); addError(msg.text); resetBtn();',
        '  } else if (msg.command === "actionDone") {',
        '    var ab = document.getElementById("action-"+msg.id);',
        '    if (ab) { ab.innerHTML = "<div class=\\"action-done\\">✓ Done</div>"; }',
        '  } else if (msg.command === "context") {',
        '    var ctxBar = document.getElementById("ctxBar");',
        '    ctxBar.style.display = "flex";',
        '    document.getElementById("ctxLabel").textContent = msg.filename ? "📄 "+msg.filename : "No file open";',
        '  } else if (msg.command === "history") {',
        '    if (msg.data && msg.data.history && msg.data.history.length > 0) {',
        '      hideWelcome();',
        '      var hist = msg.data.history.slice().reverse();',
        '      hist.forEach(function(item) {',
        '        addResponse({ query: item.query, response: item.response, intent: item.intent, detected_lang: item.detected_lang, agentic: false });',
        '      });',
        '    }',
        '  }',
        '});',
        '',
        'vscode.postMessage({ command: "getHistory" });',
    ].join('\n');
}

export function deactivate() { }