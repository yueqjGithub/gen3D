import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.scss';

// 将 React 挂载到 renderer/index.html 中的根节点；StrictMode 帮助开发时发现副作用问题。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
