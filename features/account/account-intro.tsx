import { ArrowUpRight, Bot, FolderOpen, Layers3 } from 'lucide-react';

export function AccountIntro() {
    return (
        <div className="bx-account-intro">
            <span className="bx-account-eyebrow">BXAGI CREATIVE WORKSPACE</span>
            <h1>让素材，<br />成为成品。</h1>
            <p>把创意交给合适的员工。<br />在一个工作区，管理从原始素材到广告成品的每一步。</p>
            <ol className="bx-account-journey" aria-label="工作区功能">
                <li><Layers3 size={19} aria-hidden="true" /><span><strong>统一素材</strong><small>图片、视频与业务信息</small></span></li>
                <li><Bot size={19} aria-hidden="true" /><span><strong>连接员工</strong><small>从 BXAGI 员工市场开始协作</small></span></li>
                <li><FolderOpen size={19} aria-hidden="true" /><span><strong>管理成品</strong><small>归档作品，准备下一步投放</small></span></li>
            </ol>
            <a className="bx-account-market-link" href="https://bxagi.xinlx.com/workforce" target="_blank" rel="noopener noreferrer">
                探索 BXAGI 员工市场<ArrowUpRight size={17} aria-label="在新窗口打开" />
            </a>
        </div>
    );
}
