# deploy/ — infra del servidor (infra-as-code)

Copias versionadas de la configuración de infraestructura que vive **fuera del
repo**, en el VPS Hetzner (`root@159.69.202.179`, código en `/root/Trading`). El
servidor sigue siendo la fuente de verdad en ejecución; esto es el respaldo para
poder reconstruirlo si se rehace la máquina.

## `logrotate.d/vero-trading`

Rota los logs de trading que persisten en `/root/Trading/logs/*.log` (los escriben
los servicios systemd con `StandardOutput=append:`). Sin esto, los detectores
crecen sin tope (~10 MB c/u y subiendo).

- **Va instalado en:** `/etc/logrotate.d/vero-trading`
- **Parámetros:** rotación diaria (o antes si un log pasa 50 MB), 14 rotaciones
  comprimidas, `delaycompress` (la más reciente queda sin comprimir para poder
  `grep`), `copytruncate` (copia+trunca en el mismo inode → **no reinicia
  servicios**), `missingok`, `notifempty`, `nocreate` (systemd recrea el archivo).
- **La corre:** `logrotate.timer` de systemd, diario a las 00:00.

### Cómo aplicarlo

```bash
scp deploy/logrotate.d/vero-trading root@159.69.202.179:/etc/logrotate.d/vero-trading
# validar sin rotar nada:
ssh root@159.69.202.179 'logrotate --debug /etc/logrotate.d/vero-trading'
```

El permiso debe ser `0644 root:root` (logrotate ignora configs world-writable).

## Deuda de infra pendiente

Las units systemd de `/etc/systemd/system/vero-*.service` **todavía no están
versionadas** — viven solo en el servidor. Deberían copiarse acá bajo
`deploy/systemd/` por la misma razón (reproducibilidad si se rehace el VPS).
Pendiente, no urgente.
