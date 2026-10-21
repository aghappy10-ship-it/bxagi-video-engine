'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ExternalLink, LockKeyhole, LogIn } from 'lucide-react';
import { ApiError, post } from '../../components/platform/api';
import { Button, Field } from '../../components/platform/ui';
import type { PlatformState } from '../../components/platform/use-platform';

type LoginType = 'username' | 'phone';
type BxagiLoginResult = {
    connected?: boolean;
    profile?: { displayName?: string; username?: string } | null;
};

export function loginError(reason: unknown) {
    if (reason instanceof ApiError) {
        if (reason.code === 'bxagi_encryption_unavailable') return '当前环境未完成登录配置，请使用正式站点或联系管理员。';
        if (reason.code === 'bxagi_login_rejected') return '账号或密码不正确，请核对后重新输入密码。';
        if (reason.status === 403) return '此 BXAGI 账号暂未获得访问权限，请前往账号管理检查账号状态。';
        if (reason.status === 429) return '登录请求较频繁，请稍后再试。';
        if ([408, 502, 503, 504].includes(reason.status)) return 'BXAGI 服务暂时未响应，请稍后重试。';
        return reason.message || 'BXAGI 登录失败，请稍后重试。';
    }
    if (reason instanceof TypeError) return '网络连接失败，请检查网络后重试。';
    return '暂时无法登录 BXAGI，请稍后重试。';
}

function AccountLinks() {
    return (
        <div className="bx-account-links">
            <a href="https://bxagi.xinlx.com/terms" target="_blank" rel="noopener noreferrer">
                用户协议<ExternalLink size={12} aria-label="在新窗口打开" />
            </a>
            <span aria-hidden="true">·</span>
            <a href="https://bxagi.xinlx.com/privacy" target="_blank" rel="noopener noreferrer">
                隐私政策<ExternalLink size={12} aria-label="在新窗口打开" />
            </a>
        </div>
    );
}

export function LoginForm({ state, onSuccess, onCancel, onPendingChange }: {
    state: PlatformState;
    onSuccess?: () => void;
    onCancel?: () => void;
    onPendingChange?: (pending: boolean) => void;
}) {
    const id = useId();
    const accountId = `${id}-account`;
    const passwordId = `${id}-password`;
    const errorId = `${id}-error`;
    const noteId = `${id}-note`;
    const [loginType, setLoginType] = useState<LoginType>('username');
    const [login, setLogin] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const accountInput = useRef<HTMLInputElement>(null);
    const passwordInput = useRef<HTMLInputElement>(null);
    const errorElement = useRef<HTMLDivElement>(null);
    const submissionInFlight = useRef(false);
    const mounted = useRef(false);
    const displayedError = error || (state.requiresLogin ? state.error : '');

    useEffect(() => {
        mounted.current = true;
        const input = passwordInput.current;
        return () => {
            mounted.current = false;
            if (input) input.value = '';
        };
    }, []);

    useEffect(() => {
        if (error && !pending) errorElement.current?.focus();
    }, [error, pending]);

    function clearPassword() {
        if (passwordInput.current) passwordInput.current.value = '';
    }

    function cancel() {
        if (submissionInFlight.current) return;
        clearPassword();
        onCancel?.();
    }

    function changeLoginType(type: LoginType) {
        if (submissionInFlight.current || type === loginType) return;
        setLoginType(type);
        setLogin('');
        setError('');
        clearPassword();
        accountInput.current?.focus();
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        // A ref closes the same-tick double-submit gap before React renders busy state.
        if (submissionInFlight.current) return;
        setError('');
        state.setError('');
        state.setNotice('');
        const account = login.trim();
        const password = passwordInput.current?.value || '';
        clearPassword();
        if (!account || !password) {
            setError('请输入 BXAGI 账号和密码。');
            return;
        }
        submissionInFlight.current = true;
        setPending(true);
        onPendingChange?.(true);
        try {
            // Preserve the existing BXAGI protocol; passwords never enter React state.
            const result = await post<BxagiLoginResult>('/bxagi/auth/login', {
                login: account,
                login_type: loginType,
                password,
            });
            if (!mounted.current) return;
            if (result.connected !== true) {
                setError('BXAGI 尚未确认登录，请稍后重试。');
                return;
            }
            try {
                const workspace = await state.refresh();
                if (!mounted.current) return;
                if (workspace.bxagi.connected !== true) {
                    setError('BXAGI 会话未确认，请重新登录。');
                    return;
                }
            } catch {
                if (mounted.current) setError('账号已验证，工作区暂时无法加载。请刷新页面后重试。');
                return;
            }
            state.setNotice(`已登录 BXAGI${result.profile?.displayName ? ` · ${result.profile.displayName}` : ''}。`);
            onSuccess?.();
        } catch (reason) {
            if (mounted.current) setError(loginError(reason));
        } finally {
            submissionInFlight.current = false;
            if (mounted.current) {
                setPending(false);
                onPendingChange?.(false);
            }
        }
    }

    return (
        <form className="bx-account-form" onSubmit={submit} aria-busy={pending} aria-label="BXAGI 账号登录">
            <div className="bx-account-methods" role="group" aria-label="登录方式">
                <button type="button" aria-pressed={loginType === 'username'} disabled={pending} onClick={() => changeLoginType('username')}>
                    用户名登录
                </button>
                <button type="button" aria-pressed={loginType === 'phone'} disabled={pending} onClick={() => changeLoginType('phone')}>
                    手机号登录
                </button>
            </div>

            <Field label={loginType === 'phone' ? 'BXAGI 手机号' : 'BXAGI 用户名'} htmlFor={accountId}>
                <input
                    ref={accountInput}
                    id={accountId}
                    name="login"
                    type={loginType === 'phone' ? 'tel' : 'text'}
                    inputMode={loginType === 'phone' ? 'tel' : 'text'}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    autoFocus
                    required
                    maxLength={200}
                    disabled={pending}
                    value={login}
                    aria-describedby={displayedError ? errorId : undefined}
                    onChange={event => setLogin(event.target.value)}
                    placeholder={loginType === 'phone' ? '输入注册手机号' : '输入 BXAGI 用户名'}
                />
            </Field>
            <Field label="密码" htmlFor={passwordId}>
                <input
                    ref={passwordInput}
                    id={passwordId}
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={4096}
                    disabled={pending}
                    aria-describedby={[noteId, displayedError ? errorId : ''].filter(Boolean).join(' ')}
                    placeholder="输入 BXAGI 密码"
                />
            </Field>

            <div className="bx-account-help">
                <span>使用你已有的 BXAGI 账号</span>
                <a href="https://bxagi.xinlx.com" target="_blank" rel="noopener noreferrer">
                    账号管理<ExternalLink size={13} aria-label="在新窗口打开" />
                </a>
            </div>
            <p className="bx-account-note" id={noteId}>
                <LockKeyhole size={16} aria-hidden="true" />
                <span>登录后进入你的专属工作区，按账号权限连接员工市场与执行任务。</span>
            </p>

            {displayedError && (
                <div ref={errorElement} id={errorId} className="bx-account-error" role="alert" tabIndex={-1}>
                    <AlertCircle size={18} aria-hidden="true" />
                    <span>{displayedError}</span>
                </div>
            )}
            <footer className="bx-account-actions">
                {onCancel && <Button secondary type="button" disabled={pending} onClick={cancel}>取消</Button>}
                <Button type="submit" busy={pending} disabled={!login.trim()}>
                    {!pending && <LogIn size={17} aria-hidden="true" />}
                    {pending ? '正在连接 BXAGI…' : '登录工作区'}
                </Button>
            </footer>
            <AccountLinks />
        </form>
    );
}
