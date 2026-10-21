export function nodeConnectionLabel(node={}) {
  if(node.stale===true)return '上次记录 · 待重新核实';
  if(node.status==='offline')return '节点离线';
  if(node.gatewayConnected===false)return '网关未连接';
  if(node.status==='online')return '节点在线';
  if(node.status==='busy')return '节点忙碌';
  return '连接状态待核实';
}
export function nodeObservationLabel(state) {
  if(!state)return '尚未检查';
  if(state.observationStatus!=='verified'||state.liveVerified!==true)return '状态暂未读取';
  if(!state.nodeCount)return '尚无执行节点';
  if(state.nodes.every(node=>node.status==='offline'))return '等待节点恢复';
  if(state.nodes.some(node=>['online','busy'].includes(node.status)&&node.gatewayConnected!==false))return '已读取节点状态';
  return '连接待恢复';
}
export function nodeHistoryLabel(entry={}) {
  if(entry.kind==='inspection')return entry.to==='verified'?'节点状态读取恢复':'节点状态读取暂不可用';
  if(!entry.to)return '本次列表不再包含此节点';
  if(!entry.from)return `首次记录：${nodeConnectionLabel(entry.to)}`;
  const changes=[];
  if(entry.from.status!==entry.to.status||entry.from.gatewayConnected!==entry.to.gatewayConnected)changes.push(`${nodeConnectionLabel(entry.from)} → ${nodeConnectionLabel(entry.to)}`);
  if(entry.from.heartbeatState!==entry.to.heartbeatState){const labels={fresh:'近期有心跳',stale:'心跳已超时',unknown:'心跳未提供',invalid:'心跳时间无效',future:'心跳时间待核实'};changes.push(labels[entry.to.heartbeatState]||'心跳状态变化');}
  if(entry.from.idleTimeoutMinutes!==entry.to.idleTimeoutMinutes)changes.push(`闲置回收周期：${entry.to.idleTimeoutMinutes==null?'未提供':`${entry.to.idleTimeoutMinutes} 分钟`}`);
  return changes.join('；')||'节点配置变化';
}
