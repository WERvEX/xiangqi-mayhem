/**
 * WebRTC 打洞（STUN）与中转（TURN）服务器。
 *
 * 直连优先；双方都在运营商级 NAT 后面（手机流量、很多家庭宽带）时打洞会失败，就走 TURN 中转。
 * TURN 部署在我们自己的云服务器上（安装脚本见 scripts/turn-setup.sh）。用户名密码写在前端代码里是公开的，
 * 服务器端限制了每个会话的带宽、只允许 UDP 中转、禁止中转到内网，被拿去当通用中转也没什么用。
 * 换服务器时改这里的地址和密码即可。
 */

export const TURN_HOST = '62.234.202.190'

export const ICE_SERVERS: RTCIceServer[] = [
  // 国内可用的 STUN 放前面；Google 的在国内不可用，留给海外用户
  { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  // UDP 不通的网络（部分公司、学校）还可以走 TCP
  {
    urls: [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`],
    username: 'xqm',
    credential: '5e0d38f0d107a6210e3ec54c',
  },
]
