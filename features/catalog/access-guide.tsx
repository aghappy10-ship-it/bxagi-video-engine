'use client';

import { Download, ExternalLink } from 'lucide-react';
import { saveBlob } from '../../components/platform/api';
import { Button } from '../../components/platform/ui';

// Public contracts are verified; account permission and media access still require acceptance.
const ACCESS_REQUEST = `常读内容源接入需求

目标业务：抖音端原生付费漫剧、抖音端原生免费漫剧。
用途：BXAGI 平台自动同步新剧、读取已有推广链接和授权素材，用于后续素材制作。

已核实公开文档覆盖端原生短剧/漫剧（业务类型 19、20、21、22）；请确认本账号具体业务、分销商范围及接口权限。

已核实的只读接口：
1. 剧目列表：GET /novelsale/openapi/content/aweme_series/list/v1/
   必填 distributor_id、page_index（从 0 开始，最大 10000）、page_size（最大 100）；响应 code、message、total、data。
   query 仅支持内容 ID，不支持剧名；BXAGI 的剧名搜索使用已同步剧库。
2. 已有推广链：GET /novelsale/openapi/aweme/promotion/list/v1/
   必填 distributor_id、page_index、page_size、begin_date、end_date；可用 book_id 或 promotion_id 筛选。
   此接口定义已核实，BXAGI 尚未实现推广链同步；不调用创建接口。

还需要确认或交付：
1. 账号与渠道范围：适用的 distributor_id、渠道/分包关系、付费和免费业务标识。
2. 剧目真实脱敏响应：时间字段格式/时区、授权状态枚举、增量时间筛选含义。
3. 已有推广链：日期范围格式和限制、付费/免费与渠道归属的准确对应关系。
4. 授权原始素材：剧集文件或下载清单、URL 有效期、授权范围、下载限流及文件校验信息。
5. 增量与频率：是否支持更新游标、Webhook 或最新窗口查询，明确各接口的 QPS、配额和重试规则。

请提供上述接口的脱敏请求/响应示例（保留字段名、字段类型、分页结构），不要附 Cookie、签名、token 或密钥。
API 凭据请通过受保护渠道交付；用户在 BXAGI 的“系统管理 → 内容源”中保存，不写入文档或聊天。

验收顺序：验证账户权限 → 读取一页真实剧目 → 核对付费/免费链接 → 下载一份已授权素材 → 增量同步与断点恢复。
`;

export function CatalogAccessGuide() {
    return <details className="bx-catalog-access-guide">
        <summary>如何开通常读数据接入</summary>
        <p>已内置常读官方端原生短剧／漫剧列表协议。取得对应业务的分销商标识和签名密钥后，保存配置并前往“自动抓剧”开始读取。</p>
        <ol>
            <li><strong>确认账号权限</strong><span>常读商务提供 distributor_id 和 secret_key；网页登录账号不能替代 API 凭据。</span></li>
            <li><strong>同步剧目资料</strong><span>按页读取剧名、完整来源 ID、集数与发布状态；剧名搜索在已同步剧库完成。</span></li>
            <li><strong>连接后核对真实结果</strong><span>剧目入库、推广链可读和视频可下载分别验收。</span></li>
        </ol>
        <p>已有推广链的只读接口已找到，尚未接入本站；原始视频下载还需常读提供授权素材接口。目录入库不代表视频已下载。</p>
        <div className="bx-catalog-actions">
            <Button secondary type="button" onClick={() => saveBlob(new Blob(['\uFEFF', ACCESS_REQUEST], { type: 'text/plain;charset=utf-8' }), 'changdu-api-access-request.txt')}><Download size={15}/>下载接入需求单</Button>
            <a className="bx-text-button" href="https://www.changdupingtai.com/sale/open-api-document?page=getting-started" target="_blank" rel="noopener noreferrer">常读官方文档<ExternalLink size={14}/></a>
        </div>
    </details>;
}
