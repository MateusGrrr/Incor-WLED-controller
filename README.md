# WLED Building Controller

Aplicação web para controlar 5 controladores WLED, um por andar de um prédio (1º ao 5º), rodando em um Raspberry Pi 4.

- **Backend:** Node.js 18+ / Express 5 (`server/`), porta 3000. Toda a API e o frontend compilado saem daqui.
- **Frontend:** Angular 21 standalone, zoneless (`client/`). Interface em português.

## Funcionalidades

- Liga/desliga, brilho, cor e preset (efeito nativo do WLED) por andar, com status consultado a cada 10 s.
- **Brilho limitado a 80 %** (204/255) no servidor, para qualquer rota — consumo, calor e glitch nos LEDs.
- **Nome e IP editáveis pela interface** (botão ✎ no card), persistidos em `server/data/floors.json`.
- **Playlists globais** (Outubro Rosa, Novembro Azul, Setembro Amarelo, Natal, Branco…) aplicadas a todos os andares de uma vez, com CRUD pela UI e persistência em `server/data/playlists.json`.

## Como rodar

### Desenvolvimento

```bash
# terminal 1 — API na porta 3000
cd server && npm install && npm start

# terminal 2 — Angular com proxy /api -> localhost:3000
cd client && npm install && npx ng serve --proxy-config proxy.conf.json --host 0.0.0.0
```

Se o `npm install` do client falhar com `Cannot read properties of null (reading 'edgesOut')` (bug do npm 10 ao resolver peers do jsdom), use `npm install --legacy-peer-deps`.

### Produção no Raspberry Pi

```bash
cd client && npm install && npx ng build
rm -rf ../server/public/* && cp -r dist/client/browser/* ../server/public/
cd ../server && npm install --omit=dev && npm start
```

O Express serve o frontend em `http://<ip-do-pi>:3000`. Use `pm2` ou um serviço `systemd` para subir no boot. Reserve IPs fixos para os WLEDs no roteador (padrão 192.168.1.101–105).

### Testes

```bash
cd client && npx ng test --watch=false
```

## API

| Método | Rota | Descrição |
|---|---|---|
| GET | /api/config | `{maxBrightness}` |
| GET | /api/floors | lista andares |
| PUT | /api/floors/:id | edita `{name?, ip?}` (IP validado por regex) |
| POST | /api/floors/:id/state | JSON bruto do WLED (`bri` é clampado) |
| POST | /api/floors/:id/on · /off | liga / desliga |
| POST | /api/floors/:id/brightness | `{brightness}` 0–204 |
| POST | /api/floors/:id/color | `{r, g, b}` |
| POST | /api/floors/:id/effect | `{fx, sx?, ix?, pal?}` |
| GET | /api/floors/:id/effects | `[{id, name}]` vindos do firmware (sem `RSVD` e sem metadados `@…`) |
| GET | /api/floors/:id/status | `{online, state?}` |
| GET / POST | /api/playlists | listar / criar |
| PUT / DELETE | /api/playlists/:id | editar / apagar |
| POST | /api/playlists/:id/apply | aplica em todos os andares → `{applied, total, report[]}` |
| GET | /api/hello | teste |

Todo `fetch` para o WLED tem timeout de 3 s e checa `response.ok`.

## Estrutura

```
server/
  server.js          # Express — API completa + estáticos do Angular
  data/              # criado na 1ª execução: floors.json, playlists.json
  public/            # destino do build do Angular (ignorado pelo git)
client/
  proxy.conf.json    # /api -> http://localhost:3000 (ng serve)
  src/app/
    app.ts           # componente único App (signals, CommonModule + FormsModule)
    app.html         # template
    app.css          # estilos
    app.config.ts    # provideRouter + provideHttpClient
    app.spec.ts      # testes (vitest)
```
