import * as vscode from 'vscode';
import * as https from 'https';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const API_BASE = 'https://q2eaht6bo7.execute-api.ap-south-1.amazonaws.com/prod';

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
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
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
            if (totalChars + entry.length > 100000) { break; }
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
        const proc = child_process.spawn('python', ['-c', script]);
        let output = '';
        let error = '';
        proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { error += d.toString(); });
        proc.on('close', (code: number) => {
            try { fs.unlinkSync(tmpFile); } catch {}
            if (code === 0 && output.trim()) { resolve(output.trim()); }
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
            res.on('end', () => { resolve(data); });
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
            res.on('end', () => { resolve(data); });
        }).on('error', reject);
    });
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function activate(context: vscode.ExtensionContext) {
    const provider = new DevSaarathiViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('devSaarathi.chatView', provider));
}

class DevSaarathiViewProvider implements vscode.WebviewViewProvider {
    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = getWebviewContent();

        const updateContext = () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                webviewView.webview.postMessage({ command: 'context', filename: path.basename(editor.document.fileName) });
            }
        };
        updateContext();
        vscode.window.onDidChangeActiveTextEditor(updateContext);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'startRecording') {
                await handleRecording(webviewView.webview, message.seconds || 7);
            } else if (message.command === 'getHistory') {
                await loadHistory(webviewView.webview);
            } else if (message.command === 'acceptAction') {
                await executeAgenticAction(message.intent, message.content);
                webviewView.webview.postMessage({ command: 'actionDone', id: message.id });
            } else if (message.command === 'rejectAction') {
                webviewView.webview.postMessage({ command: 'actionDone', id: message.id });
            }
        });
    }
}

async function executeAgenticAction(intent: string, content: string) {
    if (intent.includes('GIT')) {
        const commitMsg = content.replace(/^"|"$/g, '').trim();
        const terminal = vscode.window.createTerminal('Dev-Saarathi Git');
        terminal.show();
        terminal.sendText('git add . && git commit -m "' + commitMsg + '"');
        vscode.window.showInformationMessage('✅ Dev-Saarathi: Git commit executed!');
        return;
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { vscode.window.showErrorMessage('No workspace folder open!'); return; }
    const root = workspaceFolders[0].uri;
    const contentLower = content.toLowerCase();
    const isReadme = intent.includes('README') || contentLower.includes('readme') || contentLower.includes('## installation') || contentLower.includes('## usage');
    const isTest = intent.includes('TEST') || contentLower.includes('def test_') || contentLower.includes('import unittest') || contentLower.includes('import pytest');
    const isGit = intent.includes('GIT') || contentLower.includes('git commit');

    // For README: write the full response as-is (it IS the markdown)
    // For TESTS: extract just the code block
    // For others: write full response
    let cleanContent: string;
    if (isTest) {
        const codeMatch = content.match(/```(?:\w+)?\n([\s\S]*?)```/);
        cleanContent = codeMatch ? codeMatch[1].trim() : content.trim();
    } else {
        // README or general: strip surrounding explanation, keep full markdown
        // Remove any leading non-markdown preamble (lines before first # heading)
        const firstHeading = content.indexOf('\n#');
        cleanContent = firstHeading > 0 ? content.slice(firstHeading + 1).trim() : content.trim();
    }

    let fileName = 'dev-saarathi-output.md';
    if (isReadme) { fileName = 'README.md'; }
    else if (isTest) {
        const editor = vscode.window.activeTextEditor;
        const baseName = editor ? path.basename(editor.document.fileName, path.extname(editor.document.fileName)) : 'code';
        fileName = 'test_' + baseName + '.py';
    } else if (isGit) {
        const commitMsg = cleanContent.replace(/^"|"$/g, '').trim();
        const terminal = vscode.window.createTerminal('Dev-Saarathi Git');
        terminal.show();
        terminal.sendText('git add . && git commit -m "' + commitMsg + '"');
        vscode.window.showInformationMessage('✅ Dev-Saarathi: Git commit executed!');
        return;
    }
    const fileUri = vscode.Uri.joinPath(root, fileName);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(cleanContent));
    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage('✅ Dev-Saarathi created ' + fileName);
}

async function handleRecording(webview: vscode.Webview, seconds: number) {
    const userId = getUserId();
    try {
        webview.postMessage({ command: 'status', text: 'Recording for ' + seconds + 's... Speak now!' });
        const audioBase64 = await recordAudioWithPython(seconds);
        let codeContext = getActiveFileContent();
        if (!codeContext) { codeContext = await getWorkspaceContent(); }
        webview.postMessage({ command: 'status', text: 'Transcribing your voice...' });
        const body: Record<string, string> = { audio: audioBase64, user_id: userId };
        if (codeContext) { body.code_context = codeContext; }
        const triggerRaw = await httpsPost(API_BASE + '/voice', JSON.stringify(body));
        const triggerData = JSON.parse(triggerRaw) as { job_id?: string; error?: string };
        if (!triggerData.job_id) { webview.postMessage({ command: 'error', text: triggerData.error || 'Failed to start job' }); return; }
        webview.postMessage({ command: 'status', text: 'Processing with Dev-Saarathi AI...' });
        for (let i = 0; i < 60; i++) {
            await sleep(3000);
            const resultRaw = await httpsGet(API_BASE + '/result/' + triggerData.job_id);
            const resultData = JSON.parse(resultRaw) as { status: string; query?: string; response?: string; intent?: string; detected_lang?: string; error?: string; };
            if (resultData.status === 'COMPLETED') {
                webview.postMessage({ command: 'response', query: resultData.query, response: resultData.response, intent: resultData.intent, detected_lang: resultData.detected_lang, agentic: resultData.intent ? resultData.intent.startsWith('KARMA') : false });
                return;
            } else if (resultData.status === 'FAILED') {
                webview.postMessage({ command: 'error', text: resultData.error || 'Processing failed' }); return;
            }
        }
        webview.postMessage({ command: 'error', text: 'Request timed out' });
    } catch (err) { webview.postMessage({ command: 'error', text: String(err) }); }
}

async function loadHistory(webview: vscode.Webview) {
    try {
        const raw = await httpsGet(API_BASE + '/history/' + getUserId());
        webview.postMessage({ command: 'history', data: JSON.parse(raw) });
    } catch (err) { console.error('Failed to load history:', err); }
}

function getWebviewContent(): string {
    // Build the JS separately to avoid template literal issues
    const js = buildJS();
    const css = buildCSS();
    const html = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '<title>Dev-Saarathi</title>',
        "<style>@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;800&family=JetBrains+Mono:wght@400;500&display=swap');</style>",
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
        '.msg-response { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.7; white-space: pre-wrap; font-family: \"JetBrains Mono\", monospace; word-break: break-word; }',
        '.msg-response p { margin-bottom: 10px; line-height: 1.8; }',
        '.msg-response strong { color: var(--accent2); font-weight: 600; }',
        '.msg-response em { color: var(--muted); }',
        '.msg-response h1, .msg-response h2, .msg-response h3 { color: var(--accent2); margin: 10px 0 6px; font-size: 13px; font-weight: 700; }',
        '.msg-response ul { padding-left: 16px; margin: 6px 0; list-style: disc; }',
        '.msg-response li { margin: 3px 0; font-size: 12px; }',
        '.code-block { background: #000; border: 1px solid var(--border); border-radius: 6px; margin: 12px 0; overflow-x: auto; position: relative; }',
        '.code-block code { font-family: "JetBrains Mono", monospace; font-size: 11px; line-height: 1.6; padding: 32px 12px 12px; display: block; color: #abb2bf; white-space: pre; background: #000; }',
        '.code-lang { position: absolute; top: 6px; left: 10px; font-size: 8px; color: var(--muted); font-family: "JetBrains Mono", monospace; text-transform: uppercase; letter-spacing: 1px; }',
        '.copy-btn { position: absolute; top: 4px; right: 6px; background: var(--border); border: none; color: var(--muted); font-size: 9px; padding: 3px 7px; border-radius: 4px; cursor: pointer; transition: all 0.15s; letter-spacing: 0.5px; }',
        '.copy-btn:hover { background: var(--accent); color: white; }',
        '.inline-code { font-family: "JetBrains Mono", monospace; font-size: 11px; background: rgba(255,107,53,0.1); color: var(--accent); padding: 1px 5px; border-radius: 3px; }',
        '.status { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted); padding: 8px 12px; background: var(--surface); border-radius: 8px; border: 1px solid var(--border); animation: slideIn 0.3s ease; }',
        '.spinner { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }',
        '@keyframes spin { to { transform: rotate(360deg); } }',
        '.error-msg { font-size: 11px; color: var(--dosh); padding: 8px 12px; background: rgba(253,121,168,0.08); border: 1px solid rgba(253,121,168,0.2); border-radius: 8px; }',
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
        'function renderMarkdown(text) {',
        '  var blocks = [];',
        '  var TICK = String.fromCharCode(96);',
        '  var FENCE = TICK+TICK+TICK;',
        '  var fenceRe = new RegExp(FENCE+"(\\\\w*)\\\\n([\\\\s\\\\S]*?)"+FENCE, "g");',
        '  text = text.replace(/([a-zA-Z]+)COPY`([^`]+)`/g, function(_, lang, code) { return FENCE + lang + "\\n" + code.trim() + "\\n" + FENCE; });',
        '  text = text.replace(fenceRe, function(_, lang, code) {',
        '    blocks.push({ lang: lang||"", code: code.trim() });',
        '    return "%%%BLOCK_"+(blocks.length-1)+"%%%";',
        '  });',
        '  var inlineRe = new RegExp(TICK+"([^"+TICK+"]+)"+TICK, "g");',
        '  text = text.replace(inlineRe, function(_, c) { return "<span class=\\"inline-code\\">"+c+"</span>"; });',
        '  text = text.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");',
        '  text = text.replace(/\\*([^*]+)\\*/g, "<em>$1</em>");',
        '  text = text.replace(/^### (.+)$/gm, "<h3>$1</h3>");',
        '  text = text.replace(/^## (.+)$/gm, "<h2>$1</h2>");',
        '  text = text.replace(/^# (.+)$/gm, "<h1>$1</h1>");',
        '  text = text.replace(/^[-*] (.+)$/gm, "<li>$1</li>");',
        '  text = text.replace(/^\\d+\\. (.+)$/gm, "<li>$1</li>");',
        '  var lines = text.split("\\n");',
        '  var out = []; var inList = false;',
        '  for (var i=0; i<lines.length; i++) {',
        '    var t = lines[i].trim();',
        '    if (t.indexOf("<li>") === 0) {',
        '      if (!inList) { out.push("<ul>"); inList=true; }',
        '      out.push(t);',
        '    } else {',
        '      if (inList) { out.push("</ul>"); inList=false; }',
        '      if (t && t.indexOf("<h")<0 && t.indexOf("%%%")<0) { out.push("<p>"+t+"</p>"); }',
        '      else { out.push(t); }',
        '    }',
        '  }',
        '  if (inList) { out.push("</ul>"); }',
        '  text = out.join("");',
        '  for (var j=0; j<blocks.length; j++) {',
        '    var b = blocks[j];',
        '    var esc = b.code.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");',
        '    var langSpan = b.lang ? "<span class=\\"code-lang\\">"+b.lang+"</span>" : "";',
        '    var html = "<div class=\\"code-block\\">"+langSpan+"<button class=\\"copy-btn\\" onclick=\\"copyCode(this)\\">COPY</button><code>"+esc+"</code></div>";',
        '    text = text.replace("%%%BLOCK_"+j+"%%%", html);',
        '  }',
        '  return text;',
        '}',
        '',
        'function copyCode(btn) {',
        '  var code = btn.nextElementSibling.innerText;',
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
        '}',
        '',
        'function resetBtn() {',
        '  var btn = document.getElementById("micBtn");',
        '  btn.disabled = false;',
        '  btn.textContent = "\\uD83C\\uDF99 Speak Now";',
        '  clearInterval(countdownInterval);',
        '  document.getElementById("countdown").style.display = "none";',
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
        '  var el = document.createElement("div");',
        '  el.className = "error-msg";',
        '  el.textContent = "⚠️ "+text;',
        '  document.getElementById("chat").appendChild(el);',
        '  scrollToBottom();',
        '}',
        '',
        'function getActionLabel(intent, content) {',
        '  var c = (content||"").toLowerCase();',
        '  if (c.indexOf("## installation")>=0 || c.indexOf("## usage")>=0 || c.indexOf("readme")>=0) { return "\U0001f4c4 Create README.md in workspace?"; }',
        '  if (c.indexOf("def test_")>=0 || c.indexOf("import pytest")>=0 || c.indexOf("import unittest")>=0) { return "\U0001f9ea Create test file in workspace?"; }',
        '  if (c.indexOf("git commit")>=0 || c.indexOf("git add")>=0) { return "\U0001f680 Run git add . && git commit?"; }',
        '  return "\U0001f4be Save output to file?";',
        '}',
        '',
        'function acceptAction(actionId) {',
        '  var data = pendingActions[actionId];',
        '  if (!data) { return; }',
        '  vscode.postMessage({ command: "acceptAction", id: actionId, intent: data.intent, content: data.content });',
        '  delete pendingActions[actionId];',
        '}',
        '',
        'function rejectAction(actionId) {',
        '  vscode.postMessage({ command: "rejectAction", id: actionId });',
        '  delete pendingActions[actionId];',
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
        '    pendingActions[actionId] = { intent: intent, content: msg.response || "" };',
        '  }',
        '  var agenticHtml = "";',
        '  if (msg.agentic) {',
        '    agenticHtml = "<div class=\\"action-label\\">"+getActionLabel(intent, msg.response)+"</div>"',
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
        '  el.innerHTML = metaHtml + queryHtml + "<div class=\\"msg-response\\">"+rendered+"</div>" + agenticHtml;',
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

export function deactivate() {}