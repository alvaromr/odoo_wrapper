# Changelog

Los cambios que nota quien usa las herramientas, por versión. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

### Corregido

- Los errores de `odoo-dashboard --autostart` salen por la salida de errores, como los del CLI.

## [1.1.0] - 2026-11-03

### Añadido

- Aviso de versión nueva en las páginas del panel, con enlace a sus «Novedades».
- «Actualizar ahora» en el aviso: instala la versión nueva con uv, reinicia el panel en ella y actualiza las skills
  de Claude Code si el plugin está instalado. En Windows aún no se ha probado.
- «Ajustes» → «Tema»: sistema, claro u oscuro, guardado en cada navegador.
- «Ajustes» → «Actualizaciones»: comprobar ahora si hay versión nueva.
- «Solicitar cambio» junto a «Corregir» en los fichajes propios por corregir.
- «Nueva solicitud» en la página personal para todos, también para quien puede corregir.
- `SECURITY.md`: cómo avisar de una vulnerabilidad en privado, a través de GitHub.

### Cambiado

- Más contraste en el tema claro: fondo gris bajo tarjetas blancas, bordes y campos más oscuros, texto secundario y
  avisos más legibles.
- El modo móvil escucha solo en la IP de la red local, no en todas las interfaces: una VPN ya no lo expone.
  `--host 0.0.0.0` sigue escuchando en todas.
- El log del panel lleva un nivel en cada línea: INFO, WARNING o ERROR.
- El log anota una vez lo que Odoo no sirve y con qué sigue el panel: contratos, solicitudes de cambio, el campo
  «Discord», los permisos para corregir y los motivos de fichaje. También por qué una configuración dañada cuenta
  como sin configurar.
- `odoo notices` avisa cuando no puede leer su registro de filas ya escritas: las filas borradas a mano vuelven.
- Las páginas no ejecutan scripts ni estilos escritos dentro del HTML (Content-Security-Policy).

### Corregido

- La vista de gestión abierta con un enlace sin periodo mostraba «‹ undefined ›» y ninguna gráfica; ahora abre el
  periodo actual.
- Si falla la vigilancia de cambios, el panel lo anota en el log y se reinicia, en vez de quedarse mostrando un error.

## [1.0.0] - 2026-10-29

Primera versión publicada: CLI de fichaje, panel de horas, vista de gestión, avisos por Discord y hoja de avisos.

[Unreleased]: https://github.com/alvaromr/odoo_wrapper/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/alvaromr/odoo_wrapper/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/alvaromr/odoo_wrapper/releases/tag/v1.0.0
