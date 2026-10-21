'use client';

import { useState } from 'react';
import Link from 'next/link';
import { LockKeyhole } from 'lucide-react';
import { AccountIntro } from '../../features/account/account-intro';
import { LoginForm } from '../../features/account/login-form';
import { Modal } from './ui';
import type { PlatformState } from './use-platform';

export function LoginPanel({ state }: { state: PlatformState }) {
    return (
        <main className="bx-account-page">
            <div className="bx-account-layout">
                <div className="bx-account-story">
                    <Link className="bx-brand" href="/" aria-label="BXAGI 广告平台首页">
                        <span className="bx-brand-mark" aria-hidden="true"><span /><span /><span /></span>
                        <div><strong>BXAGI<span>·</span></strong><small>广告素材与投放平台</small></div>
                    </Link>
                    <AccountIntro />
                    <p className="bx-account-caption">素材生产 · 员工协作 · 成果管理</p>
                </div>
                <section className="bx-account-scope bx-account-card" aria-labelledby="bx-login-title">
                    <header className="bx-account-card-header">
                        <span className="bx-account-card-icon" aria-hidden="true"><LockKeyhole size={23} /></span>
                        <span className="bx-account-card-eyebrow">YOUR WORKSPACE</span>
                        <h2 id="bx-login-title">登录广告工作区</h2>
                        <p>一个 BXAGI 账号，连接你的素材与员工。</p>
                    </header>
                    {state.notice && <div className="bx-account-notice" role="status">{state.notice}</div>}
                    <LoginForm state={state} />
                </section>
            </div>
        </main>
    );
}

export function LoginModal({ state, onClose }: { state: PlatformState; onClose: () => void }) {
    const [pending, setPending] = useState(false);
    return (
        <Modal
            title="登录 BXAGI 账号"
            description="使用已有账号进入专属工作区，按账号权限调用员工。"
            className="bx-account-scope bx-account-modal"
            closeDisabled={pending}
            onClose={onClose}
        >
            <LoginForm state={state} onSuccess={onClose} onCancel={onClose} onPendingChange={setPending} />
        </Modal>
    );
}
