import React from 'react';
import ReactDOM from 'react-dom';
import { CodeBanterUI } from './components/CodeBanterUI';
import './styles.css';

// Initialize websocket connection
const ws = new WebSocket('ws://localhost:3000');

ws.onopen = () => {
  console.log('Connected to CodeBanter extension');
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

// Render the app once DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  ReactDOM.render(
    <React.StrictMode>
      <CodeBanterUI websocket={ws} />
    </React.StrictMode>,
    document.getElementById('root')
  );
});

// Handle cleanup
window.addEventListener('beforeunload', () => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
});