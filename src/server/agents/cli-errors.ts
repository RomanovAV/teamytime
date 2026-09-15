import { StringDecoder } from 'node:string_decoder';

/** Inspect complete stderr lines; stack frames are not authentication prompts. */
export class CliErrors {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private modelUnavailable = false;
  private authRequired = false;

  feed(chunk: Buffer, activity: (text: string) => void) {
    this.consume(this.decoder.write(chunk), activity);
  }

  end(activity: (text: string) => void) {
    this.consume(this.decoder.end() + '\n', activity);
  }

  private consume(text: string, activity: (text: string) => void) {
    const lines = (this.pending + text).split(/\r?\n/);
    this.pending = lines.pop()!.slice(-65536);
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
      if (/^at\s/.test(line)) continue;
      if (/The selected model .+ is not present in the current backend catalogue/i.test(line)) this.modelUnavailable = true;
      if (!this.modelUnavailable && /\b(?:authentication required|not authenticated|please (?:log in|login|sign in)|authorization required)\b|требуется авторизация|выполните вход/i.test(line)) {
        if (!this.authRequired) activity('GigaCode запросил авторизацию. Выполните вход в терминале.');
        this.authRequired = true;
      }
    }
  }

  message(code: number | null): string {
    if (this.modelUnavailable) return 'Выбранная модель отсутствует в каталоге текущего сервера GigaCode. Укажите доступный идентификатор модели в настройках участника или default и создайте новую задачу.';
    if (this.authRequired) return 'GigaCode запросил авторизацию. Выполните вход в терминале на машине, где запущен Teamytime.';
    return `GigaCode завершился с кодом ${code ?? 'signal'}. Подробности — в отчёте запуска (stderr).`;
  }
}
