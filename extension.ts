import * as vscode from 'vscode';
import express from 'express';
import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws'; // Import both default and named export
import { Anthropic } from '@anthropic-ai/sdk';
import * as path from 'path';
import * as fs from 'fs';
import * as webpack from 'webpack';
import * as WebpackDevServer from 'webpack-dev-server';
import * as child_process from 'child_process';

let server: http.Server | undefined;
let wss: WebSocketServer | undefined; // Update type to WebSocketServer
let originalFileContents: Map<string, string> = new Map(); // Store original file contents for diff
let devServer: WebpackDevServer | null = null;
let devServerPort = 3001; // Different from the main UI port

export function activate(context: vscode.ExtensionContext) {
    console.log('CodeBanter is now active!');

    // Register the Command with vscode first
    let disposable = vscode.commands.registerCommand('codebanter.startchat', () => {
        vscode.window.showInformationMessage('Starting CodeBanter Chat...');
        startServer(context);
    });

    // Add to subscription
    context.subscriptions.push(disposable);
}

async function startServer(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('codebanter');
    const apiKey = config.get<string>('apiKey');

    if (!apiKey) {
        const response = await vscode.window.showErrorMessage(
            'Anthropic API key not found. Would you like to configure it now?',
            'Yes',
            'No'
        );

        if (response === 'Yes') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'codebanter.apiKey');
        }
        return;
    }

    try {
        const port = config.get<number>('port') || 3000;
        const app = express();

        // Ensure UI directory exists
        const uiPath = path.join(context.extensionPath, 'ui');
        console.log(`UI Path: ${uiPath}`);
        
        if (!fs.existsSync(uiPath)) {
            vscode.window.showErrorMessage(`UI directory not found: ${uiPath}`);
            return;
        }

        // Serve static files from the bundled UI directory
        app.use(express.static(uiPath));
        app.use(express.json());

        // Create server and WebSocket instance
        server = http.createServer(app);
        wss = new WebSocketServer({ server }); // Use WebSocketServer directly

        // Set up file system watcher for open editors
        const fileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/*');
        
        fileSystemWatcher.onDidChange(uri => {
            // When a file changes, notify all clients
            broadcastFileChange(uri.fsPath);
        });

        context.subscriptions.push(fileSystemWatcher);

        // Listen for active editor changes
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                broadcastActiveEditorChange(editor.document.uri.fsPath);
            }
        }, null, context.subscriptions);

        wss.on('connection', (ws: WebSocket) => {
            console.log('New WebSocket connection');

            // Send initial workspace info
            sendWorkspaceInfo(ws);

            ws.on('message', async (message: WebSocket.RawData) => {
                try {
                    // Convert WebSocket.RawData to string
                    const messageStr = message.toString();
                    console.log('Received message:', messageStr);
                    
                    const data = JSON.parse(messageStr);
                    
                    switch (data.type) {
                        case 'chat':
                            await handleChatMessage(ws, data, apiKey);
                            break;
                        
                        case 'getFiles':
                            sendWorkspaceInfo(ws);
                            break;
                        
                        case 'getFileContent':
                            await getFileContent(ws, data.filePath);
                            break;
                        
                        case 'modifyFile':
                            await modifyFile(ws, data.filePath, data.content, data.description);
                            break;
                        
                        case 'createFile':
                            await createFile(ws, data.filePath, data.content);
                            break;
                        
                        case 'renderPreview':
                            await renderPreview(ws, data.filePath);
                            break;
                        
                        case 'getDiff':
                            await getFileDiff(ws, data.filePath);
                            break;
                        
                        case 'testFileCreation':
                            await testFileCreation(ws);
                            break;

                        default:
                            console.log(`Unknown message type: ${data.type}`);
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: `Unknown message type: ${data.type}`
                            }));
                    }
                } catch (error) {
                    console.error('Error processing message:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Error processing message'
                    }));
                }
            });
        });

        server.listen(port, () => {
            console.log(`CodeBanter server running on port ${port}`);
            vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        vscode.window.showErrorMessage(`Failed to start CodeBanter: ${error}`);
    }
}

// Define a compatible WebSocket interface
interface BrowserWebSocket {
    send(data: string): void;
}

// Send information about the current workspace to the client
function sendWorkspaceInfo(ws: BrowserWebSocket) {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const activeEditor = vscode.window.activeTextEditor;
        
        // Get list of open editors/documents
        const openFiles = vscode.workspace.textDocuments
            .filter(doc => !doc.isUntitled) // Skip untitled documents
            .map(doc => ({
                path: doc.uri.fsPath,
                name: path.basename(doc.uri.fsPath),
                language: doc.languageId,
                isActive: activeEditor?.document.uri.fsPath === doc.uri.fsPath
            }));

        // Get current workspace folders
        const folders = workspaceFolders?.map(folder => ({
            name: folder.name,
            path: folder.uri.fsPath
        })) || [];

        // Get current file content if there is an active editor
        const activeFile = activeEditor ? {
            path: activeEditor.document.uri.fsPath,
            name: path.basename(activeEditor.document.uri.fsPath),
            content: activeEditor.document.getText(),
            language: activeEditor.document.languageId
        } : null;

        console.log(`Sending workspace info: ${folders.length} folders, ${openFiles.length} open files`);
        
        ws.send(JSON.stringify({
            type: 'workspaceInfo',
            folders,
            openFiles,
            activeFile
        }));
    } catch (error) {
        console.error('Error sending workspace info:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Error retrieving workspace information'
        }));
    }
}

// Broadcast file change to all connected clients
function broadcastFileChange(filePath: string) {
    if (!wss) return;

    console.log(`Broadcasting file change: ${filePath}`);
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) { // Use WebSocket.OPEN
            client.send(JSON.stringify({
                type: 'fileChanged',
                path: filePath,
                name: path.basename(filePath)
            }));
        }
    });
}

// Broadcast active editor change to all connected clients
function broadcastActiveEditorChange(filePath: string) {
    if (!wss) return;

    console.log(`Broadcasting active editor change: ${filePath}`);
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) { // Use WebSocket.OPEN
            client.send(JSON.stringify({
                type: 'activeEditorChanged',
                path: filePath,
                name: path.basename(filePath)
            }));
        }
    });
}

// Handle chat messages and interact with Claude API
async function handleChatMessage(ws: BrowserWebSocket, data: any, apiKey: string) {
    try {
        console.log('Processing chat message with data:', JSON.stringify(data));
        
        // Log execute mode status clearly
        console.log(`Execute mode is: ${data.executeMode ? 'ENABLED' : 'DISABLED'}`);
        
        // Get context from the active editor
        let fileContext = '';
        const activeEditor = vscode.window.activeTextEditor;
        
        if (activeEditor) {
            const fileName = path.basename(activeEditor.document.uri.fsPath);
            const fileContent = activeEditor.document.getText();
            fileContext = `Currently viewing file: ${fileName}\n\nFile content:\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
        }

        // Add information about the workspace
        let workspaceContext = '';
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const folder = vscode.workspace.workspaceFolders[0];
            workspaceContext = `Working in project: ${folder.name}\n\n`;
            
            // Add list of open files
            const openFiles = vscode.workspace.textDocuments
                .filter(doc => !doc.isUntitled)
                .map(doc => path.basename(doc.uri.fsPath));
                
            if (openFiles.length > 0) {
                workspaceContext += `Open files: ${openFiles.join(', ')}\n\n`;
            }
        }

        // Prepare context for API call
        const userMessage = workspaceContext + fileContext + data.message;
        
        // Special system message for Execute mode
        const systemMessage = data.executeMode ? 
            "You are CodeBanter, a VS Code assistant that creates files directly in the user's workspace. IMPORTANT: Format your code blocks with the filename as a comment on the first line, like this: ```js // filename.js\ncode here``` or ```html <!-- index.html -->\ncode here```. The user expects you to create actual files in their workspace based on your response." :
            "You are CodeBanter, a VS Code assistant. You can view files but in Chat mode, you cannot modify them. Suggest switching to Execute mode if the user wants to make changes.";
        
        console.log(`Calling Anthropic API with ${userMessage.length} characters`);
        
        // Call the Anthropic API
        const anthropic = new Anthropic({
            apiKey: apiKey
        });

        const completion = await anthropic.messages.create({
            model: "claude-3-sonnet-20240229",
            max_tokens: 4096,
            system: systemMessage,
            messages: [{
                role: "user",
                content: userMessage
            }]
        });

        console.log('Received response from Anthropic API');
        
        const responseText = completion.content[0].text;
        
        // Process file operations if in execute mode
        let filesProcessed = false;
        if (data.executeMode) {
            filesProcessed = await processAiResponseForFileOperations(responseText, ws);
        }
        
        // Send the response back to the UI
        ws.send(JSON.stringify({
            type: 'chat',
            message: responseText,
            executeMode: data.executeMode || false,
            filesProcessed: filesProcessed
        }));
    } catch (error) {
        console.error('Error processing chat message:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Error processing chat message: ' + (error as Error).message
        }));
    }
}

// Get content of a specific file
async function getFileContent(ws: BrowserWebSocket, filePath: string) {
    try {
        console.log(`Getting content for file: ${filePath}`);
        
        // Create a URI from the file path
        const uri = vscode.Uri.file(filePath);
        
        // Try to find the document if it's already open
        let doc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filePath);
        
        // If the document isn't open, try to read it
        if (!doc) {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                const text = new TextDecoder().decode(content);
                
                // Store original content for diff
                originalFileContents.set(filePath, text);
                
                ws.send(JSON.stringify({
                    type: 'fileContent',
                    path: filePath,
                    name: path.basename(filePath),
                    content: text,
                    language: path.extname(filePath).substring(1) // Simple language detection by extension
                }));
                return;
            } catch (error) {
                throw new Error(`Failed to read file: ${filePath}`);
            }
        } else {
            // Document is open, send its content
            const content = doc.getText();
            
            // Store original content for diff
            originalFileContents.set(filePath, content);
            
            ws.send(JSON.stringify({
                type: 'fileContent',
                path: filePath,
                name: path.basename(filePath),
                content,
                language: doc.languageId
            }));
        }
    } catch (error) {
        console.error('Error getting file content:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: `Error getting file content: ${error}`
        }));
    }
}

// Generate a preview rendering for a file
async function renderPreview(ws: BrowserWebSocket, filePath: string) {
    try {
        console.log(`Rendering preview for: ${filePath}`);
        
        const uri = vscode.Uri.file(filePath);
        const ext = path.extname(filePath).toLowerCase();
        
        // Get the file content
        let content = "";
        try {
            const doc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filePath);
            if (doc) {
                content = doc.getText();
            } else {
                const data = await vscode.workspace.fs.readFile(uri);
                content = new TextDecoder().decode(data);
            }
        } catch (error) {
            throw new Error(`Failed to read file: ${filePath}`);
        }
        
        // For React component files (tsx, jsx), redirect to the dev server
        if (ext === '.tsx' || ext === '.jsx' || ext === '.ts' || ext === '.js') {
            // Start dev server if not already running
            if (!devServer) {
                await startDevServer(context);
            }
            
            // Create a special preview for React components
            const htmlPreview = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>React Component Preview - ${path.basename(filePath)}</title>
                    <style>
                        body { margin: 0; padding: 0; height: 100vh; overflow: hidden; }
                        iframe { width: 100%; height: 100%; border: none; }
                    </style>
                </head>
                <body>
                    <iframe src="http://localhost:${devServerPort}" id="devServerFrame"></iframe>
                </body>
                </html>
            `;
            
            ws.send(JSON.stringify({
                type: 'preview',
                path: filePath,
                name: path.basename(filePath),
                content: htmlPreview,
                previewType: 'html'
            }));
            return;
        }
        
        // For HTML files, send the content directly
        if (ext === '.html') {
            ws.send(JSON.stringify({
                type: 'preview',
                path: filePath,
                name: path.basename(filePath),
                content,
                previewType: 'html'
            }));
        } 
        // For CSS files, create a demo page
        else if (ext === '.css') {
            const htmlPreview = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Preview - ${path.basename(filePath)}</title>
                    <style>
                        ${content}
                    </style>
                </head>
                <body>
                    <div class="preview-container">
                        <h1>CSS Preview</h1>
                        <p>This is a preview of how the CSS might look applied to basic HTML elements.</p>
                        <button>Button Example</button>
                        <a href="#">Link Example</a>
                        <div class="box">Styled Box</div>
                    </div>
                </body>
                </html>
            `;
            
            ws.send(JSON.stringify({
                type: 'preview',
                path: filePath,
                name: path.basename(filePath),
                content: htmlPreview,
                previewType: 'html'
            }));
        }
        // For JSON files, create a syntax-highlighted view
        else if (ext === '.json') {
            try {
                // Try to parse the JSON to verify it's valid and format it nicely
                const parsedJson = JSON.parse(content);
                const formattedJson = JSON.stringify(parsedJson, null, 2);
                
                const htmlPreview = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>JSON Preview - ${path.basename(filePath)}</title>
                        <style>
                            body {
                                margin: 0;
                                padding: 20px;
                                font-family: 'Courier New', monospace;
                                background-color: #f5f5f5;
                            }
                            pre {
                                background-color: #fff;
                                border: 1px solid #ddd;
                                border-radius: 4px;
                                padding: 15px;
                                overflow: auto;
                                max-height: 90vh;
                                white-space: pre-wrap;
                            }
                            .string { color: #008000; }
                            .number { color: #0000ff; }
                            .boolean { color: #b22222; }
                            .null { color: #808080; }
                            .key { color: #a52a2a; }
                        </style>
                    </head>
                    <body>
                        <pre id="json-container">${escapeHtml(formattedJson)}</pre>
                        <script>
                            // Simple JSON syntax highlighter
                            function syntaxHighlight(json) {
                                json = json.replace(/&/g, '&amp;').replace(/<//g, '&lt;').replace(/>/g, '&gt;');
                                return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g, function (match) {
                                    var cls = 'number';
                                    if (/^"/.test(match)) {
                                        if (/:$/.test(match)) {
                                            cls = 'key';
                                        } else {
                                            cls = 'string';
                                        }
                                    } else if (/true|false/.test(match)) {
                                        cls = 'boolean';
                                    } else if (/null/.test(match)) {
                                        cls = 'null';
                                    }
                                    return '<span class="' + cls + '">' + match + '</span>';
                                });
                            }
                            
                            document.getElementById('json-container').innerHTML = syntaxHighlight(document.getElementById('json-container').textContent);
                        </script>
                    </body>
                    </html>
                `;
                
                ws.send(JSON.stringify({
                    type: 'preview',
                    path: filePath,
                    name: path.basename(filePath),
                    content: htmlPreview,
                    previewType: 'html'
                }));
            } catch (jsonError) {
                // If JSON parsing fails, just show the raw content with a warning
                const htmlPreview = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>JSON Preview (Invalid) - ${path.basename(filePath)}</title>
                        <style>
                            body {
                                margin: 0;
                                padding: 20px;
                                font-family: 'Courier New', monospace;
                                background-color: #f5f5f5;
                            }
                            .warning {
                                color: #ff0000;
                                background-color: #ffe0e0;
                                padding: 10px;
                                margin-bottom: 15px;
                                border-radius: 4px;
                            }
                            pre {
                                background-color: #fff;
                                border: 1px solid #ddd;
                                border-radius: 4px;
                                padding: 15px;
                                overflow: auto;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="warning">Warning: Invalid JSON format - ${escapeHtml(jsonError.message)}</div>
                        <pre>${escapeHtml(content)}</pre>
                    </body>
                    </html>
                `;
                
                ws.send(JSON.stringify({
                    type: 'preview',
                    path: filePath,
                    name: path.basename(filePath),
                    content: htmlPreview,
                    previewType: 'html'
                }));
            }
        }
        // For unsupported types, send an error
        else {
            ws.send(JSON.stringify({
                type: 'error',
                message: `Preview not supported for file type: ${ext}`
            }));
        }
    } catch (error) {
        console.error('Error rendering preview:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: `Error rendering preview: ${error}`
        }));
    }
}

// Helper function to escape HTML special characters
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"//g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Get diff between current and original file content
async function getFileDiff(ws: BrowserWebSocket, filePath: string) {
    try {
        console.log(`Generating diff for: ${filePath}`);
        
        // Get original content
        const originalContent = originalFileContents.get(filePath);
        if (!originalContent) {
            throw new Error(`No original content stored for ${filePath}`);
        }
        
        // Get current content
        const uri = vscode.Uri.file(filePath);
        let currentContent = "";
        
        try {
            const doc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filePath);
            if (doc) {
                currentContent = doc.getText();
            } else {
                const data = await vscode.workspace.fs.readFile(uri);
                currentContent = new TextDecoder().decode(data);
            }
        } catch (error) {
            throw new Error(`Failed to read current file: ${filePath}`);
        }
        
        // Send the diff information
        ws.send(JSON.stringify({
            type: 'diff',
            path: filePath,
            name: path.basename(filePath),
            originalContent,
            currentContent
        }));
    } catch (error) {
        console.error('Error generating diff:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: `Error generating diff: ${error}`
        }));
    }
}

// Modify an existing file
async function modifyFile(ws: BrowserWebSocket, filePath: string, content: string, description: string) {
    try {
        console.log(`Modifying file: ${filePath}`);
        
        // Create a URI from the file path
        const uri = vscode.Uri.file(filePath);
        
        // Check if the file exists
        try {
            await vscode.workspace.fs.stat(uri);
        } catch (error) {
            throw new Error(`File does not exist: ${filePath}`);
        }
        
        // Store original content for diff if not already stored
        if (!originalFileContents.has(filePath)) {
            try {
                const doc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filePath);
                if (doc) {
                    originalFileContents.set(filePath, doc.getText());
                } else {
                    const data = await vscode.workspace.fs.readFile(uri);
                    originalFileContents.set(filePath, new TextDecoder().decode(data));
                }
            } catch (error) {
                console.warn(`Could not store original content for ${filePath}`, error);
            }
        }
        
        // Try to find the document if it's already open
        const doc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filePath);
        
        if (doc) {
            // File is open, use edit API
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                uri,
                new vscode.Range(0, 0, doc.lineCount, 0),
                content
            );
            
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                throw new Error(`Failed to apply edit to ${filePath}`);
            }
        } else {
            // File is not open, write directly
            const bytes = new TextEncoder().encode(content);
            await vscode.workspace.fs.writeFile(uri, bytes);
        }
        
        // Show notification
        vscode.window.showInformationMessage(`File modified: ${path.basename(filePath)} - ${description}`);
        
        // Send success response
        ws.send(JSON.stringify({
            type: 'fileModified',
            path: filePath,
            success: true
        }));
    } catch (error) {
        console.error('Error modifying file:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: `Error modifying file: ${error}`
        }));
    }
}

// Create a new file
async function createFile(ws: BrowserWebSocket, filePath: string, content: string) {
    try {
        console.log(`Creating file: ${filePath}`);
        
        // Create a URI from the file path
        const uri = vscode.Uri.file(filePath);
        
        // Check if the file already exists
        try {
            await vscode.workspace.fs.stat(uri);
            throw new Error(`File already exists: ${filePath}`);
        } catch (error) {
            // File doesn't exist, we can create it
        }
        
        // Create the directory if it doesn't exist
        const dirPath = path.dirname(filePath);
        try {
            const dirUri = vscode.Uri.file(dirPath);
            await vscode.workspace.fs.stat(dirUri);
        } catch (error) {
            // Directory doesn't exist, create it
            // Need to create the directory structure recursively
            const parts = dirPath.split(path.sep);
            let currentPath = '';
            for (const part of parts) {
                if (!part) continue; // Skip empty parts
                currentPath = currentPath ? path.join(currentPath, part) : part;
                
                try {
                    const currentUri = vscode.Uri.file(currentPath);
                    await vscode.workspace.fs.stat(currentUri);
                } catch (error) {
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(currentPath));
                }
            }
        }
        
        // Write the file
        const bytes = new TextEncoder().encode(content);
        await vscode.workspace.fs.writeFile(uri, bytes);
        
        // Show notification
        vscode.window.showInformationMessage(`File created: ${path.basename(filePath)}`);
        
        // Send success response
        ws.send(JSON.stringify({
            type: 'fileCreated',
            path: filePath,
            success: true
        }));
    } catch (error) {
        console.error('Error creating file:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: `Error creating file: ${error}`
        }));
    }
}

async function startDevServer(context: vscode.ExtensionContext) {
    // Check if we already have a dev server running
    if (devServer) {
        console.log('Development server already running');
        return;
    }

    try {
        // Find the workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No workspace folder found');
        }
        
        const rootPath = workspaceFolders[0].uri.fsPath;
        console.log(`Starting development server in: ${rootPath}`);

        // Create a temporary package.json if one doesn't exist
        const packageJsonPath = path.join(rootPath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            fs.writeFileSync(packageJsonPath, JSON.stringify({
                name: "codebanter-preview",
                version: "0.1.0",
                private: true,
                dependencies: {
                    "react": "^17.0.2",
                    "react-dom": "^17.0.2"
                }
            }, null, 2));
            
            // Create an index.html if one doesn't exist
            const indexHtmlPath = path.join(rootPath, 'public', 'index.html');
            if (!fs.existsSync(path.dirname(indexHtmlPath))) {
                fs.mkdirSync(path.dirname(indexHtmlPath), { recursive: true });
            }
            
            fs.writeFileSync(indexHtmlPath, `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeBanter Preview</title>
</head>
<body>
    <div id="root"></div>
</body>
</html>
            `);
        }

        // Start a simple development server using npm scripts or directly
        const devServerProcess = child_process.spawn('npx', [
            'webpack-dev-server',
            '--mode=development',
            '--port', devServerPort.toString(),
            '--open=false',
            '--hot'
        ], {
            cwd: rootPath,
            stdio: 'pipe'
        });

        devServerProcess.stdout.on('data', (data) => {
            console.log(`Dev server: ${data}`);
        });

        devServerProcess.stderr.on('data', (data) => {
            console.error(`Dev server error: ${data}`);
        });

        devServerProcess.on('close', (code) => {
            console.log(`Dev server exited with code ${code}`);
            devServer = null;
        });

        // Wait for the server to start
        await new Promise<void>((resolve) => {
            setTimeout(() => {
                resolve();
            }, 3000); // Wait 3 seconds for the server to initialize
        });

        console.log(`Development server started on port ${devServerPort}`);
        
        // Notify all connected clients
        if (wss) {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'devServerStarted',
                        url: `http://localhost:${devServerPort}`
                    }));
                }
            });
        }

        // Return the dev server instance
        return devServerProcess;
    } catch (error) {
        console.error('Failed to start dev server:', error);
        vscode.window.showErrorMessage(`Failed to start development server: ${error}`);
        return null;
    }
}

function stopDevServer() {
    if (devServer) {
        console.log('Stopping development server');
        devServer.close();
        devServer = null;
    }
}

async function testFileCreation(ws: BrowserWebSocket) {
    try {
        console.log("Testing direct file creation...");
        
        // Get workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            console.error("No workspace folder open");
            ws.send(JSON.stringify({
                type: 'error',
                message: 'No workspace folder is open'
            }));
            return;
        }
        
        const workspacePath = workspaceFolders[0].uri.fsPath;
        const testFilePath = path.join(workspacePath, 'test-file.txt');
        
        // Try to create a test file
        try {
            const testFileUri = vscode.Uri.file(testFilePath);
            const encoder = new TextEncoder();
            const data = encoder.encode('This is a test file created by CodeBanter.');
            
            await vscode.workspace.fs.writeFile(testFileUri, data);
            console.log(`Successfully created test file at: ${testFilePath}`);
            
            ws.send(JSON.stringify({
                type: 'chat',
                message: `Test file created successfully at: ${testFilePath}`,
            }));
        } catch (error) {
            console.error(`Error creating test file: ${error}`);
            ws.send(JSON.stringify({
                type: 'error',
                message: `Error creating test file: ${error}`
            }));
        }
    } catch (error) {
        console.error('Error in test file creation:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: `Error in test file creation: ${error}`
        }));
    }
}

async function processAiResponseForFileOperations(message: string, ws: BrowserWebSocket) {
    console.log("Processing AI response for file operations");
    console.log("Message length:", message.length);
    
    // Log the first 500 characters of the message to see its format
    console.log("Message preview:", message.substring(0, 500));
    
    // Regular expressions to match code blocks with file paths in comments
    // Let's add more flexible patterns to catch different formats
    const filePatterns = [
        // Standard pattern: ```js // filename.js
        /```(?:js|javascript|html|css|tsx|jsx)?\s*(?:\/\/|<!--)\s*(.*?\.[\w]+)[\s\n]+([\s\S]*?)```/g,
        
        // Alternative pattern: ```filename.js
        /```(.*?\.[\w]+)[\s\n]+([\s\S]*?)```/g,
        
        // File heading pattern: # filename.js or ## filename.js
        /#+\s+(.*?\.[\w]+)[\s\n]+([\s\S]*?)(?=#+|$)/g
    ];
    
    let operationsPerformed = false;
    
    // Try each pattern
    for (const pattern of filePatterns) {
        console.log(`Trying pattern: ${pattern}`);
        
        let match;
        while ((match = pattern.exec(message)) !== null) {
            const filePath = match[1].trim();
            let content = match[2].trim();
            
            console.log(`Found potential file: ${filePath}`);
            console.log(`Content preview: ${content.substring(0, 100)}...`);
            
            // Ensure we have a valid file path
            if (!filePath || !content) continue;
            
            // Create full path (relative to workspace root)
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'No workspace folder is open'
                }));
                return;
            }
            
            // Construct absolute file path
            const workspacePath = workspaceFolders[0].uri.fsPath;
            const absoluteFilePath = path.isAbsolute(filePath) 
                ? filePath 
                : path.join(workspacePath, filePath);
            
            try {
                // Check if file exists
                try {
                    await vscode.workspace.fs.stat(vscode.Uri.file(absoluteFilePath));
                    
                    // File exists, modify it
                    await modifyFile(ws, absoluteFilePath, content, `Updated by AI`);
                    console.log(`Modified file: ${absoluteFilePath}`);
                } catch (e) {
                    // File doesn't exist, create it
                    await createFile(ws, absoluteFilePath, content);
                    console.log(`Created file: ${absoluteFilePath}`);
                }
                
                operationsPerformed = true;
            } catch (error) {
                console.error(`Error processing file ${filePath}:`, error);
                ws.send(JSON.stringify({
                    type: 'error',
                    message: `Error processing file ${filePath}: ${error}`
                }));
            }
        }
    }
    
    if (!operationsPerformed) {
        console.log("No file operations found in AI response");
    }
    
    return operationsPerformed;
}

export function deactivate() {
    if (server) {
        server.close();
    }
    if (wss) {
        wss.close();
    }
    stopDevServer();
}