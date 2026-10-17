import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConsoleApp } from '../src/client.jsx';
createRoot(document.getElementById('root')).render(<ConsoleApp demo openSession={id=>alert(`这是模拟会话 ${id}。安装到 DSH 后，此按钮打开原生会话。`)}/>);
