import React, { useState, useEffect, useRef } from 'react';
import { 
  Send, Copy, BookmarkPlus, 
  MessageSquare, Code, Wand2,
  Upload, RefreshCw,
  Settings, Clock, FileText, Folder,
  Eye, GitBranch, FileCode
} from 'lucide-react';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    isBookmarked: boolean;
    executeMode?: boolean;
}

interface WorkspaceFolder {
    name: string;
    path: string;
}

interface WorkspaceFile {
    path: string;
    name: string;
    language: string;
    isActive?: boolean;
}

interface ActiveFile {
    path: string;
    name: string;
    content: string;
    language: string;
}

interface WorkspaceInfo {
    folders: WorkspaceFolder[];
    openFiles: WorkspaceFile[];
    activeFile: ActiveFile | null;
}

interface FileDiff {
    originalContent: string;
    currentContent: string;
}

const CodeBanterUI: React.FC = () => {
    const [activeTab, setActiveTab] = useState('Chat');
    const [darkMode, setDarkMode] = useState(false);
    const [chatInput, setChatInput] = useState('');
    const [isExecuteMode, setIsExecuteMode] = useState(false);
    const [isChatExpanded] = useState(true);
    const [viewMode, setViewMode] = useState('preview');
    const [websocket, setWebsocket] = useState<WebSocket | null>(null);
    const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
    const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null);
    const [fileContent, setFileContent] = useState<string>('');
    const [diffInfo, setDiffInfo] = useState<FileDiff | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const previewFrameRef = useRef<HTMLIFrameElement>(null);

    // History items for the History tab
    const historyItems = [
        {
            id: '300',
            title: 'Implement recipe details page',
            timestamp: 'Feb 17, 2025, 11:15 PM - 4 days ago'
        },
        {
            id: '308',
            title: 'Implement plan',
            timestamp: 'Feb 18, 2025, 1:28 PM - 4 days ago'
        },
        {
            id: '321',
            title: 'Fix recipe display issues',
            timestamp: 'Feb 20, 2025, 1:04 AM - 2 days ago',
            status: 'Reverted'
        }
    ];

    // Chat messages
    const [chatHistory, setChatHistory] = useState<Message[]>([
        {
            id: '1',
            role: 'assistant',
            content: 'Hello! I\'m connected to your VS Code. What would you like to do?',
            timestamp: new Date().toISOString(),
            isBookmarked: false
        }
    ]);

    // Connect to WebSocket
    useEffect(() => {
        const ws = new WebSocket('ws://localhost:3000');
        
        ws.onopen = () => {
            console.log('Connected to WebSocket');
            setWebsocket(ws);
            setIsConnected(true);
            
            // Request workspace info immediately after connection
            ws.send(JSON.stringify({
                type: 'getFiles'
            }));
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            console.log('Received message:', data);
            
            switch (data.type) {
                case 'chat':
                    addMessage('assistant', data.message, data.executeMode);
                    break;
                
                case 'error':
                    console.error('Error:', data.message);
                    addMessage('assistant', `Error: ${data.message}`);
                    break;
                
                case 'workspaceInfo':
                    setWorkspaceInfo(data);
                    // If we have an active file, display it in the preview
                    if (data.activeFile) {
                        setSelectedFile({
                            path: data.activeFile.path,
                            name: data.activeFile.name,
                            language: data.activeFile.language,
                            isActive: true
                        });
                        setFileContent(data.activeFile.content);
                        
                        // Request a preview if in preview mode
                        if (viewMode === 'preview') {
                            requestFilePreview(data.activeFile.path);
                        }
                    }
                    break;
                
                case 'fileContent':
                    setSelectedFile({
                        path: data.path,
                        name: data.name,
                        language: data.language
                    });
                    setFileContent(data.content);
                    
                    // Request a preview if in preview mode
                    if (viewMode === 'preview') {
                        requestFilePreview(data.path);
                    }
                    
                    // Request diff if in diff mode
                    if (viewMode === 'diff') {
                        requestFileDiff(data.path);
                    }
                    break;
                
                case 'preview':
                    if (previewFrameRef.current) {
                        try {
                            // Set iframe content directly
                            const doc = previewFrameRef.current.contentDocument;
                            if (doc) {
                                doc.open();
                                doc.write(data.content);
                                doc.close();
                            }
                        } catch (error) {
                            console.error('Error setting iframe content', error);
                        }
                    }
                    break;
                
                case 'diff':
                    setDiffInfo({
                        originalContent: data.originalContent,
                        currentContent: data.currentContent
                    });
                    break;
                
                case 'fileModified':
                    // Request updated file content
                    if (selectedFile && selectedFile.path === data.path) {
                        ws.send(JSON.stringify({
                            type: 'getFileContent',
                            filePath: data.path
                        }));
                    }
                    // Request updated workspace info
                    ws.send(JSON.stringify({
                        type: 'getFiles'
                    }));
                    break;
                
                case 'fileCreated':
                    // Request updated workspace info
                    ws.send(JSON.stringify({
                        type: 'getFiles'
                    }));
                    break;
                
                case 'fileChanged':
                case 'activeEditorChanged':
                    // If this is our currently selected file, refresh it
                    if (selectedFile && selectedFile.path === data.path) {
                        requestFileContent(data.path);
                    }
                    // Refresh workspace info
                    refreshWorkspaceInfo();
                    break;
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            setIsConnected(false);
        };

        ws.onclose = () => {
            console.log('WebSocket connection closed');
            setIsConnected(false);
        };

        return () => {
            ws.close();
        };
    }, []);

    // Function to request file content
    const requestFileContent = (filePath: string) => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
                type: 'getFileContent',
                filePath
            }));
        }
    };
    
    // Function to request file preview
    const requestFilePreview = (filePath: string) => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
                type: 'renderPreview',
                filePath
            }));
        }
    };
    
    // Function to request file diff
    const requestFileDiff = (filePath: string) => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
                type: 'getDiff',
                filePath
            }));
        }
    };

    // Add a new message to the chat history
    const addMessage = (role: 'user' | 'assistant', content: string, executeMode?: boolean) => {
        const newMessage: Message = {
            id: Date.now().toString(),
            role,
            content,
            timestamp: new Date().toISOString(),
            isBookmarked: false,
            executeMode
        };
        setChatHistory(prev => [...prev, newMessage]);
    };

    // Handle form submission
    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!chatInput.trim() || !websocket || websocket.readyState !== WebSocket.OPEN) return;

        // Add context about the currently selected file
        let messageWithContext = chatInput;
        if (selectedFile && isExecuteMode) {
            messageWithContext = `Working with file: ${selectedFile.path}\n\n${chatInput}`;
        }

        // Send message to server
        websocket.send(JSON.stringify({
            type: 'chat',
            message: messageWithContext,
            executeMode: isExecuteMode
        }));

        // Add user message to chat
        addMessage('user', chatInput);
        setChatInput('');
    };

    // Request updated workspace info
    const refreshWorkspaceInfo = () => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
                type: 'getFiles'
            }));
        }
    };

    // Toggle bookmark status for a message
    const toggleBookmark = (messageId: string) => {
        setChatHistory(chatHistory.map(msg => 
            msg.id === messageId 
            ? { ...msg, isBookmarked: !msg.isBookmarked }
            : msg
        ));
    };

    // Handle view mode change
    const handleViewModeChange = (mode: string) => {
        setViewMode(mode);
        
        if (selectedFile) {
            if (mode === 'preview') {
                requestFilePreview(selectedFile.path);
            } else if (mode === 'diff') {
                requestFileDiff(selectedFile.path);
            }
        }
    };

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatHistory]);

    // Helper function to render diff view
    const renderDiffView = () => {
        if (!diffInfo) return <div className="text-center text-gray-500">No diff information available</div>;
        
        const originalLines = diffInfo.originalContent.split('\n');
        const currentLines = diffInfo.currentContent.split('\n');
        const maxLines = Math.max(originalLines.length, currentLines.length);
        
        return (
            <div className="flex h-full">
                <div className="w-1/2 overflow-auto p-2 border-r">
                    <h3 className="text-sm font-semibold mb-2">Original</h3>
                    <pre className="text-xs">
                        {Array.from({ length: maxLines }, (_, index) => (
                            <div 
                                key={index} 
                                className={`whitespace-pre ${
                                    index < currentLines.length && index < originalLines.length && originalLines[index] !== currentLines[index] 
                                        ? 'bg-red-100 text-red-800' 
                                        : ''
                                }`}
                            >
                                {index < originalLines.length ? originalLines[index] : ''}
                            </div>
                        ))}
                    </pre>
                </div>
                <div className="w-1/2 overflow-auto p-2">
                    <h3 className="text-sm font-semibold mb-2">Current</h3>
                    <pre className="text-xs">
                        {Array.from({ length: maxLines }, (_, index) => (
                            <div 
                                key={index} 
                                className={`whitespace-pre ${
                                    index < originalLines.length && index < currentLines.length && currentLines[index] !== originalLines[index] 
                                        ? 'bg-green-100 text-green-800' 
                                        : ''
                                }`}
                            >
                                {index < currentLines.length ? currentLines[index] : ''}
                            </div>
                        ))}
                    </pre>
                </div>
            </div>
        );
    };

    return (
        <div className={`h-screen flex flex-col ${darkMode ? 'bg-gray-900 text-gray-100' : 'bg-white text-gray-900'}`}>
            {/* Connection Status */}
            {!isConnected && (
                <div className="bg-red-500 text-white text-center py-1">
                    Not connected to VS Code. Please check your extension is running.
                </div>
            )}
            
            {/* Top Navigation */}
            <div className="flex justify-between items-center border-b border-gray-700 px-4">
                <div className="flex flex-1">
                    {['Chat', 'History', 'Plan'].map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`px-8 py-3 text-sm font-medium ${
                                activeTab === tab 
                                ? darkMode 
                                    ? 'bg-gray-800 text-white' 
                                    : 'bg-gray-200 text-gray-900'
                                : 'text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                
                <div className="flex items-center gap-4 pr-4">
                    <button onClick={refreshWorkspaceInfo} className="p-2" title="Refresh Workspace Info">
                        <RefreshCw className="w-4 h-4" />
                    </button>
                    <button onClick={() => setDarkMode(!darkMode)} className="p-2">
                        {darkMode ? '☀️' : '🌙'}
                    </button>
                    <Settings className="w-5 h-5" />
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex">
                {/* Left Panel - Chat/History/Plan */}
                <div className={`${isChatExpanded ? 'w-1/3' : 'w-16'} flex flex-col border-r border-gray-700 transition-all duration-300`}>
                    {activeTab === 'Chat' && (
                        <>
                            {/* Chat History */}
                            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                                {chatHistory.map((message) => (
                                    <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                        <div className={`rounded-lg p-3 max-w-[85%] flex items-start gap-2 group
                                        ${message.role === 'user' 
                                            ? 'bg-blue-600 text-white' 
                                            : message.executeMode
                                                ? 'bg-green-600 text-white'
                                                : darkMode ? 'bg-gray-800' : 'bg-gray-100'}`}>
                                            <p className="flex-1 whitespace-pre-wrap">{message.content}</p>
                                            <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                                                <button onClick={() => toggleBookmark(message.id)}>
                                                    <BookmarkPlus className={`w-4 h-4 ${message.isBookmarked ? 'fill-current' : ''}`} />
                                                </button>
                                                <button onClick={() => {
                                                    navigator.clipboard.writeText(message.content);
                                                }}>
                                                    <Copy className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                                <div ref={messagesEndRef} />
                            </div>

                            {/* Chat Input */}
                            <div className={`p-4 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                                <form onSubmit={handleSubmit} className="space-y-2">
                                    <div className="flex gap-2 mb-3">
                                        <input
                                            type="text"
                                            value={chatInput}
                                            onChange={(e) => setChatInput(e.target.value)}
                                            placeholder={isExecuteMode ? "Enter instructions to execute..." : "Ask CodeBanter..."}
                                            className={`flex-1 rounded-lg px-4 py-2 ${
                                                darkMode 
                                                ? 'bg-gray-800 border-gray-700' 
                                                : 'bg-white border-gray-300'
                                            } border`}
                                        />
                                        <button type="button" className="p-2 hover:bg-gray-700 rounded">
                                            <Upload className="w-5 h-5" />
                                        </button>
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setIsExecuteMode(false)}
                                            className={`flex-1 p-2 rounded-lg flex items-center justify-center gap-2 ${
                                                !isExecuteMode 
                                                ? 'bg-blue-100 text-blue-700' 
                                                : darkMode 
                                                    ? 'border border-gray-700 hover:bg-gray-800'
                                                    : 'border border-gray-300 hover:bg-gray-50'
                                            }`}
                                        >
                                            <MessageSquare className="w-4 h-4" />
                                            Chat
                                        </button>
                                        <button 
                                            type="button"
                                            onClick={() => setIsExecuteMode(true)}
                                            className={`flex-1 p-2 rounded-lg flex items-center justify-center gap-2 ${
                                                isExecuteMode 
                                                ? 'bg-green-100 text-green-700' 
                                                : darkMode
                                                    ? 'border border-gray-700 hover:bg-gray-800'
                                                    : 'border border-gray-300 hover:bg-gray-50'
                                            }`}
                                        >
                                            <Code className="w-4 h-4" />
                                            Execute
                                        </button>
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            className={`flex-1 py-1 px-3 rounded border ${
                                                darkMode 
                                                ? 'border-gray-700 hover:bg-gray-800' 
                                                : 'border-gray-300 hover:bg-gray-50'
                                            } text-sm flex items-center justify-center gap-2`}
                                        >
                                            <Wand2 className="w-4 h-4" />
                                            Enhance Prompt
                                        </button>
                                        <button
                                            type="submit"
                                            className={`rounded px-6 py-1 flex items-center justify-center ${
                                                isExecuteMode
                                                    ? 'bg-green-600 text-white hover:bg-green-700'
                                                    : 'bg-blue-600 text-white hover:bg-blue-700'
                                            }`}
                                            disabled={!isConnected}
                                        >
                                            <Send className="w-5 h-5" />
                                        </button>
                                    </div>
                                </form>
                            </div>
                        </>
                    )}

                    {activeTab === 'History' && (
                        <div className="flex-1 overflow-y-auto p-4">
                            {historyItems.map(item => (
                                <div 
                                    key={item.id}
                                    className={`mb-2 p-4 rounded-lg ${
                                        darkMode ? 'bg-gray-800' : 'bg-gray-100'
                                    }`}
                                >
                                    <div className="flex items-center gap-3">
                                        <Clock className="w-5 h-5 text-gray-500" />
                                        <div>
                                            <div className="font-medium">#{item.id} - {item.title}</div>
                                            <div className="text-sm text-gray-500">{item.timestamp}</div>
                                        </div>
                                    </div>
                                    {item.status && (
                                        <span className="mt-2 inline-block px-2 py-1 text-sm bg-red-500/10 text-red-500 rounded">
                                            {item.status}
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {activeTab === 'Plan' && (
                        <div className="flex-1 p-4">
                            <div className="mb-4 font-medium">VS Code Workspace</div>
                            
                            {/* Folders */}
                            {workspaceInfo?.folders && workspaceInfo.folders.length > 0 ? (
                                <div className="mb-4">
                                    <div className="text-sm text-gray-500 mb-2">Folders</div>
                                    {workspaceInfo.folders.map(folder => (
                                        <div 
                                            key={folder.path}
                                            className={`flex items-center gap-2 p-2 rounded ${
                                                darkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-100'
                                            }`}
                                        >
                                            <Folder className="w-4 h-4 text-blue-500" />
                                            <span>{folder.name}</span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-sm text-gray-500">No folders open</div>
                            )}
                            
                            {/* Open Files */}
                            {workspaceInfo?.openFiles && workspaceInfo.openFiles.length > 0 ? (
                                <div>
                                    <div className="text-sm text-gray-500 mb-2">Open Files</div>
                                    {workspaceInfo.openFiles.map(file => (
                                        <div 
                                            key={file.path}
                                            className={`flex items-center gap-2 p-2 rounded cursor-pointer ${
                                                file.isActive 
                                                    ? darkMode ? 'bg-gray-800' : 'bg-gray-200'
                                                    : darkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-100'
                                            }`}
                                            onClick={() => requestFileContent(file.path)}
                                        >
                                            <FileText className="w-4 h-4 text-blue-500" />
                                            <span>{file.name}</span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-sm text-gray-500">No files open</div>
                            )}
                        </div>
                    )}
                </div>

                {/* Right Panel - Preview */}
                <div className={`${isChatExpanded ? 'w-2/3' : 'flex-1'} p-4 ${darkMode ? 'bg-gray-900' : 'bg-white'} transition-all duration-300`}>
                    <div className={`h-full rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-white'}`}>
                        <div className={`border-b p-2 flex justify-between items-center ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                            <div className="flex gap-2">
                                <button 
                                    onClick={() => handleViewModeChange('preview')}
                                    className={`px-3 py-1 rounded flex items-center gap-1 ${
                                        viewMode === 'preview' 
                                        ? darkMode ? 'bg-gray-800' : 'bg-gray-100'
                                        : darkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-50'
                                    }`}
                                >
                                    <Eye className="w-4 h-4" />
                                    <span>Preview</span>
                                </button>
                                <button 
                                    onClick={() => handleViewModeChange('raw')}
                                    className={`px-3 py-1 rounded flex items-center gap-1 ${
                                        viewMode === 'raw' 
                                        ? darkMode ? 'bg-gray-800' : 'bg-gray-100'
                                        : darkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-50'
                                    }`}
                                >
                                    <FileCode className="w-4 h-4" />
                                    <span>Raw</span>
                                </button>
                                <button 
                                    onClick={() => handleViewModeChange('diff')}
                                    className={`px-3 py-1 rounded flex items-center gap-1 ${
                                        viewMode === 'diff' 
                                        ? darkMode ? 'bg-gray-800' : 'bg-gray-100'
                                        : darkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-50'
                                    }`}
                                >
                                    <GitBranch className="w-4 h-4" />
                                    <span>Diff</span>
                                </button>
                            </div>
                            <div className="flex items-center gap-2">
                                {selectedFile && (
                                    <span className="text-sm text-gray-500">{selectedFile.name}</span>
                                )}
                                <button 
                                    className={darkMode ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'}
                                    onClick={refreshWorkspaceInfo}
                                >
                                    <RefreshCw className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                        <div className="p-4 h-[calc(100vh-8rem)] overflow-auto">
                            {selectedFile ? (
                                viewMode === 'preview' ? (
                                    <iframe 
                                        ref={previewFrameRef}
                                        className="w-full h-full border-0" 
                                        title="Preview"
                                        sandbox="allow-scripts allow-same-origin"
                                    />
                                ) : viewMode === 'diff' ? (
                                    renderDiffView()
                                ) : (
                                    <pre className={`w-full h-full font-mono text-sm ${
                                        darkMode ? 'bg-gray-800 text-gray-300' : 'bg-gray-50 text-gray-800'
                                    } p-4 rounded-lg overflow-auto`}>
                                        {fileContent}
                                    </pre>
                                )
                            ) : (
                                <div className={`w-full h-full rounded-lg flex items-center justify-center ${
                                    darkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-50 text-gray-400'
                                }`}>
                                    {viewMode === 'preview' && 'Select a file to preview'}
                                    {viewMode === 'raw' && 'Select a file to view raw code'}
                                    {viewMode === 'diff' && 'Select a file to view differences'}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CodeBanterUI;