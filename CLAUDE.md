# WLED Building Controller — contexto do projeto

## O que é

Aplicação web rodando em um Raspberry Pi 4 para controlar 5 WLEDs, um por andar de um prédio (1º ao 5º). Backend Node.js/Express 5, frontend Angular 21 standalone **zoneless** (sem zone.js). Interface em português.

## Estrutura do repositório

```
server/
  server.js          # Express, porta 3000 — TODA a API e serve o build do Angular
  package.json       # deps: express ^5.2.1, cors ^2.8.6 — "start": "node server.js"
  data/              # criado automaticamente na 1ª execução (ignorado pelo git)
    floors.json      # nome + IP de cada andar (editável pela UI)
    playlists.json   # playlists globais
  public/            # destino do build do Angular (dist/client/browser/*) — ignorado pelo git
client/
  proxy.conf.json    # /api -> http://localhost:3000 (só para ng serve)
  src/
    index.html       # <app-root>, fonte Inter via Google Fonts (com fallback system-ui)
    main.ts          # bootstrapApplication(App, appConfig)
    styles.css       # global mínimo (fundo #070a0f)
    app/
      app.ts         # componente único App (standalone, CommonModule + FormsModule, estado em signals)
      app.html       # template
      app.css        # estilos do componente
      app.config.ts  # provideRouter(routes) + provideHttpClient()
      app.routes.ts  # []
      app.spec.ts    # testa criação e h1 "WLED Control" (com provideHttpClientTesting) — vitest
```

## Como rodar

- Dev: `cd server && npm start` e `cd client && npx ng serve --proxy-config proxy.conf.json` (adicionar `--host 0.0.0.0` para acessar de outro dispositivo).
- Produção no Pi: `npx ng build`, copiar `dist/client/browser/*` para `server/public/`, rodar só `npm start` (Express serve o frontend na 3000). Sugestão: pm2 ou systemd para subir no boot.
- Requer Node 18+ no servidor (usa `fetch` e `AbortSignal.timeout` nativos); Angular 21 exige Node 20.19+/22.12+ para buildar.
- Se `npm install` do client falhar com `reading 'edgesOut'` (bug do npm 10 com peers do jsdom), usar `--legacy-peer-deps`.
- Testes: `cd client && npx ng test --watch=false`.

## Decisões importantes

- **Zoneless:** o `ng new` do Angular 21 não inclui zone.js. Todo estado que muda depois de um `await` (status, playlists, andares, editor) é `signal`; andares são atualizados de forma imutável via `patchFloor(id, patch)`. Não voltar a usar propriedades simples mutadas em callbacks assíncronos — a tela não redesenha.
- **Brilho limitado a 80%** (`MAX_BRIGHTNESS = 204`), clampado dentro de `sendToWLED` (raiz e `seg[].bri`) — vale para qualquer rota, inclusive `/state` bruto e playlists. Frontend lê `GET /api/config` e usa como `max` dos sliders; a porcentagem continua relativa a 255 para o fim do slider mostrar 80%.
- **IPs editáveis pela interface** (trocar um WLED que pifar sem acesso à rede). `PUT /api/floors/:id` valida IP por regex e persiste em `data/floors.json`; status é reconsultado no IP novo.
- **Presets = efeitos nativos do WLED.** Lista vem de `GET /api/floors/:id/effects` (proxy de `/json/effects`, remove sufixo `@metadados` e `RSVD`); frontend tenta andares em sequência, com lista fallback embutida (`FALLBACK_EFFECTS`). `checkStatus` lê `seg[0].fx`.
- **Playlists globais:** `{id, name, colors[3 hex], fx, sx, ix, pal, bri}`; `POST /api/playlists/:id/apply` envia a todos com `Promise.allSettled` e devolve `{applied, total, report[]}`. Padrão `pal: 5` ("Colors Only"). Defaults: Outubro Rosa, Novembro Azul, Setembro Amarelo, Natal (Theater, fx 13), Branco (Solid). Mudar cor/preset de um andar limpa `activePlaylistId`.
- Timeout de 3 s (`AbortSignal.timeout`) em todo `fetch` ao WLED; checagem de `response.ok`. Helpers `findFloorOr404` / `applyState`.
- `express.static` + fallback para `index.html` (rotas não-`/api`); `/api/*` desconhecido retorna 404 JSON.

## API (server.js)

| Método | Rota | Descrição |
|---|---|---|
| GET | /api/config | `{maxBrightness}` |
| GET | /api/floors | lista andares |
| PUT | /api/floors/:id | edita `{name?, ip?}` |
| POST | /api/floors/:id/state | JSON bruto WLED (bri é clampado) |
| POST | /api/floors/:id/on · /off | liga/desliga |
| POST | /api/floors/:id/brightness | `{brightness}` 0–204 |
| POST | /api/floors/:id/color | `{r,g,b}` |
| POST | /api/floors/:id/effect | `{fx, sx?, ix?, pal?}` |
| GET | /api/floors/:id/effects | `[{id,name}]` do firmware |
| GET | /api/floors/:id/status | `{online, state?}` |
| GET/POST | /api/playlists | listar / criar |
| PUT/DELETE | /api/playlists/:id | editar / apagar |
| POST | /api/playlists/:id/apply | aplica em todos os andares |
| GET | /api/hello | teste |

## Design atual

Fundo escuro #070a0f, acento ciano #00e5ff / verde #00ffa3, fonte Inter, cards por andar com lâmpada (cor real do WLED) e glow proporcional ao brilho, grid 5 colunas responsivo (3 → 2 → 1). Seção de playlists acima do grid, com editor inline. Variáveis CSS em `:host` no `app.css`.

## Pendências / próximos passos

- Alterações visuais da interface (o usuário vai detalhar).
- Ao testar com WLEDs reais: conferir se os ids de efeito das playlists default (67 Colorwaves, 13 Theater) batem com o firmware; ajustar em `data/playlists.json` se necessário.
- IPs default 192.168.1.101–105; garantir reserva DHCP fixa no roteador.
