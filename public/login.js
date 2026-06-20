const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

const reason = new URLSearchParams(window.location.search).get('reason');
if (reason && loginError) {
    loginError.textContent = reason;
}

async function loginRequest(username, password) {
    let response;
    try {
        response = await fetch('/api/login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
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

loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submitBtn = loginForm.querySelector('button[type="submit"]');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    if (loginError) loginError.textContent = '';
    if (submitBtn) submitBtn.disabled = true;

    try {
        await loginRequest(username, password);
        window.location.replace('/');
    } catch (error) {
        if (loginError) loginError.textContent = error.message;
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
});
