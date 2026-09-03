import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

export interface Floor {
  id: number;
  name: string;
  ip: string;
  on: boolean;
  brightness: number;
  color: string; // hex #rrggbb
  fx: number;
  online: boolean;
  busy: boolean;
  editing: boolean;
  editName: string;
  editIp: string;
  editError: string;
}

export interface Effect {
  id: number;
  name: string;
}

export interface Playlist {
  id: string;
  name: string;
  colors: [string, string, string];
  fx: number;
  sx: number;
  ix: number;
  pal: number;
  bri: number;
}

interface WledState {
  on?: boolean;
  bri?: number;
  seg?: Array<{ col?: number[][]; fx?: number }>;
}

interface StatusResponse {
  online: boolean;
  state?: WledState;
}

interface ApplyReport {
  applied: number;
  total: number;
  report: Array<{ floor: number; name: string; ok: boolean; error?: string }>;
}

/** Lista fallback caso nenhum WLED responda ao pedir /json/effects. */
export const FALLBACK_EFFECTS: Effect[] = [
  { id: 0, name: 'Solid' },
  { id: 1, name: 'Blink' },
  { id: 2, name: 'Breathe' },
  { id: 3, name: 'Wipe' },
  { id: 8, name: 'Colorloop' },
  { id: 9, name: 'Rainbow' },
  { id: 12, name: 'Fade' },
  { id: 13, name: 'Theater' },
  { id: 15, name: 'Running' },
  { id: 20, name: 'Sparkle' },
  { id: 27, name: 'Android' },
  { id: 28, name: 'Chase' },
  { id: 38, name: 'Aurora' },
  { id: 42, name: 'Fireworks' },
  { id: 44, name: 'Fire 2012' },
  { id: 63, name: 'Pride 2015' },
  { id: 66, name: 'Fire Flicker' },
  { id: 67, name: 'Colorwaves' },
  { id: 70, name: 'Colortwinkles' },
  { id: 71, name: 'Lake' },
  { id: 74, name: 'Twinklefox' },
  { id: 80, name: 'Twinkleup' },
  { id: 101, name: 'Pacifica' },
  { id: 110, name: 'Flow' },
];

const STATUS_POLL_MS = 10_000;
const DEFAULT_MAX_BRIGHTNESS = 204;

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);

  readonly title = 'WLED Control';

  // A aplicação roda em modo zoneless: todo estado que muda após um `await`
  // precisa ser signal para a tela redesenhar.
  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly maxBrightness = signal(DEFAULT_MAX_BRIGHTNESS);

  readonly floors = signal<Floor[]>([]);
  readonly effects = signal<Effect[]>(FALLBACK_EFFECTS);
  readonly effectsSource = signal<'wled' | 'fallback'>('fallback');
  readonly onlineCount = computed(() => this.floors().filter((f) => f.online).length);

  readonly playlists = signal<Playlist[]>([]);
  readonly activePlaylistId = signal<string | null>(null);
  readonly applyingPlaylistId = signal<string | null>(null);
  readonly playlistMessage = signal('');
  readonly playlistError = signal('');

  /** Editor de playlist (null = fechado). */
  readonly playlistDraft = signal<Playlist | null>(null);
  readonly playlistDraftIsNew = signal(false);
  readonly playlistDraftError = signal('');

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    this.loadError.set('');
    try {
      await this.loadConfig();
      await Promise.all([this.loadFloors(), this.loadPlaylists()]);
      this.loading.set(false);
      await this.refreshAll();
      void this.loadEffects();
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => void this.refreshAll(), STATUS_POLL_MS);
      }
    } catch (err) {
      this.loading.set(false);
      this.loadError.set('Não foi possível conectar ao servidor. Verifique se o backend está rodando.');
      console.error(err);
    }
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // ---------------------------------------------------------------------------
  // Carregamento inicial
  // ---------------------------------------------------------------------------

  private async loadConfig(): Promise<void> {
    const cfg = await firstValueFrom(this.http.get<{ maxBrightness: number }>('/api/config'));
    if (cfg?.maxBrightness) this.maxBrightness.set(Number(cfg.maxBrightness));
  }

  private async loadFloors(): Promise<void> {
    const raw = await firstValueFrom(
      this.http.get<Array<{ id: number; name: string; ip: string }>>('/api/floors'),
    );
    this.floors.set(
      raw.map((f) => ({
        id: f.id,
        name: f.name,
        ip: f.ip,
        on: false,
        brightness: this.maxBrightness(),
        color: '#ffffff',
        fx: 0,
        online: false,
        busy: false,
        editing: false,
        editName: f.name,
        editIp: f.ip,
        editError: '',
      })),
    );
  }

  private async loadPlaylists(): Promise<void> {
    this.playlists.set(await firstValueFrom(this.http.get<Playlist[]>('/api/playlists')));
  }

  /** Tenta os andares em sequência até um responder com a lista de efeitos. */
  private async loadEffects(): Promise<void> {
    for (const floor of this.floors()) {
      try {
        const list = await firstValueFrom(this.http.get<Effect[]>(`/api/floors/${floor.id}/effects`));
        if (Array.isArray(list) && list.length > 0) {
          this.effects.set(list);
          this.effectsSource.set('wled');
          return;
        }
      } catch {
        // tenta o próximo andar
      }
    }
    this.effects.set(FALLBACK_EFFECTS);
    this.effectsSource.set('fallback');
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  async refreshAll(): Promise<void> {
    await Promise.all(this.floors().map((f) => this.checkStatus(f.id)));
  }

  async checkStatus(floorId: number): Promise<void> {
    try {
      const res = await firstValueFrom(this.http.get<StatusResponse>(`/api/floors/${floorId}/status`));
      const patch: Partial<Floor> = { online: !!res.online };
      if (res.online && res.state) {
        const s = res.state;
        if (typeof s.on === 'boolean') patch.on = s.on;
        if (typeof s.bri === 'number') patch.brightness = Math.min(s.bri, this.maxBrightness());
        const seg0 = s.seg?.[0];
        const col = seg0?.col?.[0];
        if (col && col.length >= 3) patch.color = this.rgbToHex(col[0], col[1], col[2]);
        if (typeof seg0?.fx === 'number') patch.fx = seg0.fx;
      }
      this.patchFloor(floorId, patch);
    } catch {
      this.patchFloor(floorId, { online: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Controles por andar
  // ---------------------------------------------------------------------------

  async toggle(floor: Floor): Promise<void> {
    const next = !floor.on;
    await this.send(floor, `/api/floors/${floor.id}/${next ? 'on' : 'off'}`, {}, { on: next });
  }

  /** Atualiza só o rótulo enquanto o slider é arrastado. */
  previewBrightness(floor: Floor, value: string | number): void {
    this.patchFloor(floor.id, { brightness: Math.min(Number(value), this.maxBrightness()) });
  }

  async setBrightness(floor: Floor, value: string | number): Promise<void> {
    const brightness = Math.min(Number(value), this.maxBrightness());
    this.patchFloor(floor.id, { brightness });
    await this.send(floor, `/api/floors/${floor.id}/brightness`, { brightness });
  }

  async setColor(floor: Floor, hex: string): Promise<void> {
    const rgb = this.hexToRgb(hex);
    if (!rgb) return;
    this.patchFloor(floor.id, { color: hex });
    this.activePlaylistId.set(null);
    await this.send(floor, `/api/floors/${floor.id}/color`, { r: rgb[0], g: rgb[1], b: rgb[2] });
  }

  async setEffect(floor: Floor, value: string | number): Promise<void> {
    const fx = Number(value);
    if (!Number.isFinite(fx)) return;
    this.patchFloor(floor.id, { fx });
    this.activePlaylistId.set(null);
    await this.send(floor, `/api/floors/${floor.id}/effect`, { fx });
  }

  private async send(floor: Floor, url: string, body: unknown, onSuccess: Partial<Floor> = {}): Promise<void> {
    this.patchFloor(floor.id, { busy: true });
    try {
      await firstValueFrom(this.http.post(url, body));
      this.patchFloor(floor.id, { ...onSuccess, online: true, busy: false });
    } catch (err) {
      this.patchFloor(floor.id, { online: false, busy: false });
      console.error(`Falha ao enviar para ${floor.name}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Edição de nome/IP
  // ---------------------------------------------------------------------------

  startEdit(floor: Floor): void {
    this.patchFloor(floor.id, { editing: true, editName: floor.name, editIp: floor.ip, editError: '' });
  }

  cancelEdit(floor: Floor): void {
    this.patchFloor(floor.id, { editing: false, editError: '' });
  }

  async saveEdit(floor: Floor): Promise<void> {
    const name = floor.editName.trim();
    const ip = floor.editIp.trim();
    if (!name) {
      this.patchFloor(floor.id, { editError: 'Informe um nome.' });
      return;
    }
    if (!this.isValidIp(ip)) {
      this.patchFloor(floor.id, { editError: 'IP inválido (ex.: 192.168.1.101).' });
      return;
    }
    try {
      const saved = await firstValueFrom(
        this.http.put<{ id: number; name: string; ip: string }>(`/api/floors/${floor.id}`, { name, ip }),
      );
      this.patchFloor(floor.id, { name: saved.name, ip: saved.ip, editing: false, editError: '' });
      await this.checkStatus(floor.id);
    } catch (err: unknown) {
      this.patchFloor(floor.id, { editError: this.extractError(err, 'Não foi possível salvar.') });
    }
  }

  // ---------------------------------------------------------------------------
  // Playlists
  // ---------------------------------------------------------------------------

  async applyPlaylist(pl: Playlist): Promise<void> {
    this.applyingPlaylistId.set(pl.id);
    this.playlistMessage.set('');
    this.playlistError.set('');
    try {
      const res = await firstValueFrom(this.http.post<ApplyReport>(`/api/playlists/${pl.id}/apply`, {}));
      this.activePlaylistId.set(pl.id);
      if (res.applied === res.total) {
        this.playlistMessage.set(`"${pl.name}" aplicada em todos os ${res.total} andares.`);
      } else {
        const failed = res.report.filter((r) => !r.ok).map((r) => r.name).join(', ');
        this.playlistError.set(
          `"${pl.name}" aplicada em ${res.applied} de ${res.total} andares. Sem resposta: ${failed}.`,
        );
      }
      await this.refreshAll();
    } catch (err: unknown) {
      this.playlistError.set(this.extractError(err, 'Falha ao aplicar a playlist.'));
    } finally {
      this.applyingPlaylistId.set(null);
    }
  }

  newPlaylist(): void {
    this.playlistDraft.set({
      id: '',
      name: '',
      colors: ['#00e5ff', '#00ffa3', '#ffffff'],
      fx: 67,
      sx: 96,
      ix: 128,
      pal: 5,
      bri: this.maxBrightness(),
    });
    this.playlistDraftIsNew.set(true);
    this.playlistDraftError.set('');
  }

  editPlaylist(pl: Playlist): void {
    this.playlistDraft.set({ ...pl, colors: [...pl.colors] as [string, string, string] });
    this.playlistDraftIsNew.set(false);
    this.playlistDraftError.set('');
  }

  cancelPlaylistEdit(): void {
    this.playlistDraft.set(null);
    this.playlistDraftError.set('');
  }

  async savePlaylist(): Promise<void> {
    const draft = this.playlistDraft();
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      this.playlistDraftError.set('Informe um nome para a playlist.');
      return;
    }
    const body = {
      name,
      colors: draft.colors,
      fx: Number(draft.fx),
      sx: Number(draft.sx),
      ix: Number(draft.ix),
      pal: Number(draft.pal),
      bri: Math.min(Number(draft.bri), this.maxBrightness()),
    };
    try {
      if (this.playlistDraftIsNew()) {
        const created = await firstValueFrom(this.http.post<Playlist>('/api/playlists', body));
        this.playlists.update((list) => [...list, created]);
      } else {
        const updated = await firstValueFrom(this.http.put<Playlist>(`/api/playlists/${draft.id}`, body));
        this.playlists.update((list) => list.map((p) => (p.id === updated.id ? updated : p)));
      }
      this.playlistDraft.set(null);
    } catch (err: unknown) {
      this.playlistDraftError.set(this.extractError(err, 'Não foi possível salvar a playlist.'));
    }
  }

  async deletePlaylist(pl: Playlist): Promise<void> {
    if (!confirm(`Apagar a playlist "${pl.name}"?`)) return;
    try {
      await firstValueFrom(this.http.delete(`/api/playlists/${pl.id}`));
      this.playlists.update((list) => list.filter((p) => p.id !== pl.id));
      if (this.activePlaylistId() === pl.id) this.activePlaylistId.set(null);
      if (this.playlistDraft()?.id === pl.id) this.playlistDraft.set(null);
    } catch (err: unknown) {
      this.playlistError.set(this.extractError(err, 'Não foi possível apagar a playlist.'));
    }
  }

  // ---------------------------------------------------------------------------
  // Utilitários
  // ---------------------------------------------------------------------------

  private patchFloor(id: number, patch: Partial<Floor>): void {
    this.floors.update((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  /** Percentual relativo a 255, para o fim do slider mostrar 80%. */
  brightnessPercent(value: number): number {
    return Math.round((Number(value) / 255) * 100);
  }

  effectKnown(fx: number): boolean {
    return this.effects().some((e) => e.id === fx);
  }

  effectName(fx: number): string {
    return this.effects().find((e) => e.id === fx)?.name ?? `Efeito ${fx}`;
  }

  rgbToHex(r: number, g: number, b: number): string {
    const to = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${to(r)}${to(g)}${to(b)}`;
  }

  hexToRgb(hex: string): [number, number, number] | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  isValidIp(ip: string): boolean {
    return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(ip);
  }

  trackFloor(_: number, floor: Floor): number {
    return floor.id;
  }

  trackPlaylist(_: number, pl: Playlist): string {
    return pl.id;
  }

  private extractError(err: unknown, fallback: string): string {
    const e = err as { error?: { error?: string }; message?: string } | null;
    return e?.error?.error || fallback;
  }
}
