import { Store } from './store';
import { diagnosticLimits, redact, runtimeInfo } from './diagnostics';

export function runReport(store: Store, runId: string) {
  // Synchronous reads produce one snapshot before compression yields to other work.
  const run = store.get(runId), diagnostics = store.diagnostics(runId);
  const recorded = new Set(diagnostics.map(t => t.turnId));
  return redact({
    format: 'teamytime-run-report', formatVersion: 1, exportedAt: new Date().toISOString(), runtime: runtimeInfo(),
    run, events: store.runEvents(runId),
    diagnostics: {
      limits: diagnosticLimits, turns: diagnostics,
      missingTurnIds: run.turns.filter(t => t.startedAt && !recorded.has(t.id)).map(t => t.id),
      notes: [
        'Снимок одной задачи на момент скачивания. Текст задания, диалог и артефакты включены.',
        'Журналы фиксируются по завершённым строкам. Незавершённая строка появится после её окончания или выхода CLI.',
        'Сохраняется хвост каждого потока. droppedEntries показывает число удалённых записей; слишком длинные строки отмечены отдельно.',
        'Вызовы и результаты инструментов, а также компактный итог CLI сохраняются в потоке evidence с отдельным лимитом.',
        'workspaceChanges сравнивает содержимое файлов Git до и после хода, включая прежние незакоммиченные изменения. Игнорируемые и служебные файлы не входят; incomplete означает неполную проверку. Авторство изменений этим сравнением не устанавливается.',
        'outcome: null означает незавершённый журнал (ход ещё работает или процесс был аварийно прерван). Текущий статус хода указан в run.turns.',
        'Потоковые дельты, вложенные события субагентов и дубли ответов пропущены; output-filtered показывает их количество. Итоговый ответ уже находится в снимке задачи, аргументы корневых инструментов остаются в evidence.',
        'Известные поля секретов, ссылки авторизации и локальные пути маскируются. Произвольные секреты в свободном тексте могут остаться.',
        'Для ходов до включения диагностики исходные stdout/stderr недоступны. Файлы рабочего каталога и хранилище авторизации не включаются.',
      ],
    },
  }, run.workspace);
}
