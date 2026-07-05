import './app.css';
import './appshell.css';
import 'katex/dist/katex.min.css';
import { mount } from 'svelte';
import App from './App.svelte';

const app = mount(App, { target: document.getElementById('app') });
export default app;
