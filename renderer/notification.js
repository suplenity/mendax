'use strict';

const params = new URLSearchParams(location.search);
const type   = params.get('type')  || 'complete';
const title  = params.get('title') || 'Mendax';
const body   = params.get('body')  || '';
const theme  = params.get('theme') || 'blue';

// Apply theme
document.documentElement.setAttribute('data-theme', theme);

// Populate
const notifEl = document.getElementById('notif');
notifEl.classList.add(type);

document.getElementById('notif-icon').textContent  = type === 'complete' ? '✓' : '!';
document.getElementById('notif-title').textContent = title;
document.getElementById('notif-body').textContent  = body;

// Click anywhere to dismiss
document.addEventListener('click', () => window.close());
