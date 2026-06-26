const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const authTitle = document.getElementById('auth-title');
const authSubtitle = document.getElementById('auth-subtitle');
const authSubmit = document.getElementById('auth-submit');
const passwordInput = document.getElementById('login-password');
const confirmGroup = document.getElementById('register-confirm-group');
const confirmInput = document.getElementById('register-password-confirm');
let setupMode = false;

const reason = new URLSearchParams(window.location.search).get('reason');
if (reason && loginError) {
    loginError.textContent = reason;
}

async function apiRequest(path, body) {
    let response;
    try {
        response = await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
    } catch {
        throw new Error('无法连接到服务器，请确认 Node 服务已启动');
    }

    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
        throw new Error(data?.error || '登录失败，请重试');
    }

    return data;
}

async function loadSetupState() {
    let response;
    try {
        response = await fetch('/api/me', {
            credentials: 'same-origin'
        });
    } catch {
        return;
    }

    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok || !data?.setupRequired) return;

    setupMode = true;
    if (authTitle) authTitle.textContent = '创建管理员账号';
    if (authSubtitle) authSubtitle.textContent = '首次部署，请先设置管理员账号';
    if (authSubmit) authSubmit.textContent = '创建并进入';
    if (passwordInput) passwordInput.autocomplete = 'new-password';
    if (confirmGroup) confirmGroup.hidden = false;
    if (confirmInput) confirmInput.required = true;
}

loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submitBtn = loginForm.querySelector('button[type="submit"]');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const passwordConfirm = confirmInput?.value || '';

    if (loginError) loginError.textContent = '';
    if (setupMode && password !== passwordConfirm) {
        if (loginError) loginError.textContent = '两次输入的密码不一致';
        return;
    }

    if (submitBtn) submitBtn.disabled = true;

    try {
        await apiRequest(setupMode ? '/api/setup/register' : '/api/login', { username, password });
        window.location.replace('/');
    } catch (error) {
        if (loginError) loginError.textContent = error.message;
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
});

loadSetupState();
