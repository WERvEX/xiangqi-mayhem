#!/usr/bin/env bash
# 在一台 Ubuntu 22.04 / 24.04 云服务器上安装联机中转（TURN）。
#
#   用法（在服务器上执行）：
#     bash turn-setup.sh <公网IP> [内网IP]
#
#   内网 IP 不填时自动取默认网卡的地址（腾讯云、阿里云的服务器都是 1:1 NAT，需要同时告诉 coturn 公网和内网地址）。
#   运行结束会打印用户名和密码，填进 src/net/iceServers.ts。
#
#   还需要在云服务商控制台的防火墙 / 安全组里放行：
#     UDP 3478、TCP 3478、UDP 49152-49999
set -euo pipefail

PUBLIC_IP="${1:?用法：bash turn-setup.sh <公网IP> [内网IP]}"
PRIVATE_IP="${2:-$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')}"
TURN_USER="xqm"
TURN_PASS="$(openssl rand -hex 12)"

sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn

sudo tee /etc/turnserver.conf > /dev/null <<EOF
# 象棋大乱斗联机中转（TURN）。棋步消息很小，以下限制足够对局使用，又不值得被拿去当通用中转。
listening-port=3478
external-ip=${PUBLIC_IP}/${PRIVATE_IP}
min-port=49152
max-port=49999

realm=xiangqi-mayhem
lt-cred-mech
user=${TURN_USER}:${TURN_PASS}
fingerprint

# 只做 UDP 中转（WebRTC 数据通道只需要这个），不提供 TCP 中转，避免被当作网页代理
no-tcp-relay
no-tls
no-dtls
no-cli
no-multicast-peers
no-software-attribute

# 带宽：每个中转会话最多 16 KB/s，全部会话合计约 2.4 Mbps（按 3 Mbps 带宽的服务器留余量）
max-bps=16000
bps-capacity=300000
total-quota=300
stale-nonce=600

# 不允许中转到内网、本机和保留地址
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

log-file=/var/log/turnserver/turnserver.log
simple-log
EOF
sudo mkdir -p /var/log/turnserver
sudo chown turnserver:turnserver /var/log/turnserver
sudo chown root:turnserver /etc/turnserver.conf
sudo chmod 640 /etc/turnserver.conf

# 日志轮转，避免写满磁盘
sudo tee /etc/logrotate.d/turnserver-xqm > /dev/null <<EOF
/var/log/turnserver/*.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
  copytruncate
}
EOF

echo "TURNSERVER_ENABLED=1" | sudo tee /etc/default/coturn > /dev/null
sudo systemctl enable coturn > /dev/null 2>&1
sudo systemctl restart coturn

# 系统防火墙：先放行 SSH，避免把自己关在外面
if command -v ufw > /dev/null; then
  sudo ufw allow OpenSSH > /dev/null
  sudo ufw allow 3478/udp > /dev/null
  sudo ufw allow 3478/tcp > /dev/null
  sudo ufw allow 49152:49999/udp > /dev/null
  sudo ufw --force enable > /dev/null
fi

sleep 1
systemctl is-active coturn
echo
echo "安装完成。填进 src/net/iceServers.ts："
echo "  TURN_HOST = '${PUBLIC_IP}'"
echo "  username: '${TURN_USER}'"
echo "  credential: '${TURN_PASS}'"
