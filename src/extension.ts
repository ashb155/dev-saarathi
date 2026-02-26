import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Dev-Saarathi is now active!');

	const provider = new DevSaarathiViewProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(DevSaarathiViewProvider.viewType, provider)
	);
}

class DevSaarathiViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'devSaarathi.chatView';

	constructor(private readonly _extensionUri: vscode.Uri) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		// Enable scripts so our submit button works
		webviewView.webview.options = { enableScripts: true };

		// Inject the HTML UI for your 4 hackathon modes
		webviewView.webview.html = this._getHtmlForWebview();

		// Listen for messages from the webview (when the user clicks the button)
		webviewView.webview.onDidReceiveMessage(data => {
			switch (data.type) {
				case 'sendPrompt':
					// This creates a little popup in VS Code to prove it received the input!
					vscode.window.showInformationMessage(`[${data.mode}] Input received: ${data.value}`);
					break;
			}
		});
	}

	private _getHtmlForWebview() {
		return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Dev-Saarathi</title>
            <style>
                /* Using VS Code CSS variables makes it seamlessly match the developer's theme! */
                body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-editor-foreground); }
                label { display: block; margin-bottom: 5px; font-weight: bold; }
                select, textarea, button { 
                    width: 100%; 
                    margin-bottom: 15px; 
                    padding: 8px; 
                    box-sizing: border-box;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                }
                button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    cursor: pointer;
                    border: none;
                    font-weight: bold;
                    padding: 10px;
                }
                button:hover { background: var(--vscode-button-hoverBackground); }
                h3 { margin-top: 0; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
            </style>
        </head>
        <body>
            <h3>Dev-Saarathi</h3>
            
            <label for="modeSelect">Select Intent:</label>
            <select id="modeSelect">
                <option value="Vaani-Srijan">Vaani-Srijan (Coding)</option>
                <option value="Gyaan-Setu">Gyaan-Setu (Learning)</option>
                <option value="Dosh-Drishti">Dosh-Drishti (Debugging)</option>
                <option value="Karma-Kavach">Karma-Kavach (Ops Safety)</option>
            </select>
            
            <label for="promptInput">Vernacular Input:</label>
            <textarea id="promptInput" rows="5" placeholder="e.g., 'इस array को sort कैसे करें?'"></textarea>
            
            <button id="submitBtn">Send to Orchestrator</button>
            
            <button id="micBtn" style="background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);">🎙️ Start Voice Input (Pulse-Batch)</button>

            <script>
                const vscode = acquireVsCodeApi();
                
                document.getElementById('submitBtn').addEventListener('click', () => {
                    const prompt = document.getElementById('promptInput').value;
                    const mode = document.getElementById('modeSelect').value;
                    vscode.postMessage({ type: 'sendPrompt', value: prompt, mode: mode });
                });
            </script>
        </body>
        </html>`;
	}
}