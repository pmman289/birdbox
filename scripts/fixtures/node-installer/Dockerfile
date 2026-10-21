FROM node:24-bookworm@sha256:7b559cf7f77d837192392499a850abb1a3d1f49fbc2bd0692d54b212c9e38f6d

ARG BIRD_VERSION=2.17.5
ENV container=docker
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       systemd systemd-sysv bird2 curl iproute2 flex bison libreadline-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --retry 3 --max-time 120 "https://bird.nic.cz/download/bird-${BIRD_VERSION}.tar.gz" -o /tmp/bird.tar.gz \
    && tar -xzf /tmp/bird.tar.gz -C /tmp \
    && cd "/tmp/bird-${BIRD_VERSION}" \
    && ./configure --prefix=/usr --sysconfdir=/etc/bird --localstatedir=/var --runstatedir=/run/bird \
    && make -j4 && make install \
    && rm -rf /tmp/bird*

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
