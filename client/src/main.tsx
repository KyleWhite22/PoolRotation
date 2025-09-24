import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css'; // 👈 THIS MUST EXIST

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
