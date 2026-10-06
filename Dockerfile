FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html main.js README.md .nojekyll /srv/
COPY decal/ /srv/decal/
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
