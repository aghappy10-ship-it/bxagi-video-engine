'use client';

import { Dialog } from '@base-ui/react/dialog';
import { ArrowRight, Check, ChevronRight, Loader2, UploadCloud, X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
export function Button({ children, secondary = false, danger = false, busy = false, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    secondary?: boolean;
    danger?: boolean;
    busy?: boolean;
}) {
    return (
        <button
            {...props}
            disabled={props.disabled || busy}
            aria-busy={busy || undefined}
            className={`bx-button ${secondary ? 'secondary' : ''} ${danger ? 'danger' : ''} ${className}`}
        >
            {busy && <Loader2 size={16} className="spin" aria-hidden="true" />}
            {children}
        </button>
    );
}
export function Badge({ children, tone = 'neutral' }: {
    children: ReactNode;
    tone?: string;
}) { return <span className={`bx-badge ${tone}`}>{children}</span>; }
export function Panel({ title, subtitle, action, children, className = '' }: {
    title?: ReactNode;
    subtitle?: ReactNode;
    action?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <section className={`bx-panel ${className}`}>
            {title && (
                <header className="bx-panel-head">
                    <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
                    {action}
                </header>
            )}
            <div className="bx-panel-body">{children}</div>
        </section>
    );
}
export function Empty({ title, description, action, icon }: {
    title: string;
    description: string;
    action?: ReactNode;
    icon?: ReactNode;
}) {
    return (
        <div className="bx-empty">
            <span className="bx-empty-icon" aria-hidden="true">{icon || <UploadCloud size={28} />}</span>
            <h3>{title}</h3>
            <p>{description}</p>
            {action}
        </div>
    );
}
export function Field({ label, children, hint, className = '', htmlFor, hintId }: {
    label: string;
    children: ReactNode;
    hint?: string;
    className?: string;
    htmlFor?: string;
    hintId?: string;
}) {
    return (
        <label className={`bx-field ${className}`} htmlFor={htmlFor}>
            <span>{label}</span>
            {children}
            {hint && <small id={hintId}>{hint}</small>}
        </label>
    );
}
export function Modal({ title, description, onClose, children, className = '', closeDisabled = false }: {
    title: string;
    description?: string;
    onClose: () => void;
    children: ReactNode;
    className?: string;
    closeDisabled?: boolean;
}) {
    const popupRef = useRef<HTMLDivElement>(null);
    // Capture before child autoFocus runs, including callers without a Dialog.Trigger.
    const returnFocusTarget = useRef<HTMLElement | null>(
        typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null,
    );
    return (
        <Dialog.Root
            open
            modal
            disablePointerDismissal={closeDisabled}
            onOpenChange={(open, details) => {
                if (closeDisabled) {
                    details.cancel();
                    return;
                }
                if (!open) onClose();
            }}
        >
            <Dialog.Portal>
                <Dialog.Viewport className="bx-modal-backdrop">
                    <Dialog.Popup
                        ref={popupRef}
                        className={`bx-modal ${className}`}
                        initialFocus={interaction => {
                            if (interaction === 'touch') return popupRef.current;
                            return popupRef.current?.querySelector<HTMLElement>(
                                'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])',
                            ) || true;
                        }}
                        finalFocus={() => returnFocusTarget.current?.isConnected ? returnFocusTarget.current : true}
                    >
                        <header>
                            <div>
                                <Dialog.Title>{title}</Dialog.Title>
                                {description && <Dialog.Description>{description}</Dialog.Description>}
                            </div>
                            <Dialog.Close className="bx-icon-button" aria-label="关闭对话框" disabled={closeDisabled}>
                                <X size={20} aria-hidden="true" />
                            </Dialog.Close>
                        </header>
                        {children}
                    </Dialog.Popup>
                </Dialog.Viewport>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
export function Steps({ active = 0 }: {
    active?: number;
}) {
    const steps = ['上传原始素材', '员工优化与生产', '审核并设置预算', '投放与效果闭环'];
    return (
        <div className="bx-steps" aria-label="素材与投放流程">
            {steps.map((step, index) => (
                <div key={step} className={index === active ? 'active' : index < active ? 'done' : ''} aria-current={index === active ? 'step' : undefined}>
                    <span>{index < active ? <Check size={14} aria-label="已完成" /> : String(index + 1).padStart(2, '0')}</span>
                    {step}
                    {index < steps.length - 1 && <ChevronRight size={14} aria-hidden="true" />}
                </div>
            ))}
        </div>
    );
}
export function LinkButton({ children, onClick }: {
    children: ReactNode;
    onClick: () => void;
}) {
    return <button className="bx-text-button" type="button" onClick={onClick}>{children}<ArrowRight size={15} aria-hidden="true" /></button>;
}
export type StatusContext = 'campaign' | 'production' | 'generic';

const STATUS_LABELS: Record<string, string> = {
    draft: '待审核',
    rejected: '已拒绝',
    approved: '已审核',
    reviewed: '已审核',
    ready: '待投放',
    active: '投放中',
    running: '执行中',
    paused: '已暂停',
    blocked: '待配置',
    pending: '处理中',
    failed: '失败',
    submitted: '已提交',
    needs_configuration: '待配置',
    launching: '提交中',
    launch_uncertain: '需核查渠道状态',
    needs_reconciliation: '需核查渠道状态',
    awaiting_browser_generation: '等待生成',
    awaiting_creative_plan: '等待方案',
    queued: '已入队',
    processing: '处理中',
    complete: '已完成',
    completed: '已完成',
    producing: '员工生产中',
    awaiting_data: '继续收集数据',
    starting: '员工接单中',
    uploading: '同步素材中',
    awaiting_result: '等待远端结果',
    awaiting_user_input: '需要补充信息',
    awaiting_user_confirmation: '等待你的确认',
    validating: '归档校验中',
    partial: '部分交付',
    awaiting_node: '等待节点恢复',
    waiting_for_node: '等待节点恢复',
    awaiting_conversation: '等待员工会话',
    awaiting_upload: '等待素材交付',
};

export function statusLabel(status: string, context: StatusContext = 'generic') {
    if (status === 'running' && context === 'campaign') return '投放中';
    return STATUS_LABELS[status] || status || '待处理';
}

export function Status({ status, context = 'generic' }: { status: string; context?: StatusContext }) {
    const success = ['approved', 'reviewed', 'active', 'running', 'complete', 'completed'].includes(status);
    const attention = ['blocked', 'failed', 'rejected', 'launch_uncertain', 'needs_reconciliation', 'awaiting_user_input'].includes(status);
    return <Badge tone={success ? 'green' : attention ? 'amber' : 'neutral'}>{statusLabel(status, context)}</Badge>;
}
