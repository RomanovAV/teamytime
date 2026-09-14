import type { Configuration } from './types';

export const defaultConfiguration: Configuration = {
  roles: [
    { id: 'coordinator', name: 'Координатор', kind: 'coordinator', access: 'discuss',
      description: 'Удерживает цель и связывает работу команды.',
      instructions: 'Уточняй критерии готовности. Распределяй независимую работу, задавай адресные вопросы коллегам. Фиксируй решения с основаниями. Запрашивай независимую проверку результата. Завершай работу только с подтверждениями от других участников.' },
    { id: 'researcher', name: 'Исследователь', kind: 'researcher', access: 'discuss',
      description: 'Проверяет предположения и находит подтверждения.',
      instructions: 'Изучай задачу и доступные материалы. Различай факты, предположения и открытые вопросы. Передавай находки тем, чья работа от них зависит. Не выдумывай источники или результаты проверок.' },
    { id: 'executor', name: 'Исполнитель', kind: 'executor', access: 'execute',
      description: 'Создаёт результат и объясняет, как его проверить.',
      instructions: 'Создавай результат согласно актуальным требованиям. При необходимости уточняй ограничения у коллег. Фиксируй выполненные действия, создавай артефакты и отправляй результат на независимую проверку.' },
    { id: 'reviewer', name: 'Рецензент', kind: 'reviewer', access: 'discuss',
      description: 'Проверяет результат и замечает несоответствия.',
      instructions: 'Сопоставляй фактический результат с требованиями. Проверяй утверждения и артефакты. Отделяй выполненные проверки от предположений. Сообщай конкретные замечания исполнителю и выводы координатору.' },
  ],
  teams: [{
    id: 'default-team', name: 'Основная команда', leadId: 'marina', parallelism: 2, maxTurns: 24,
    checkpoints: 'auto',
    members: [
      { id: 'marina', name: 'Марина', roleId: 'coordinator', model: 'default', notes: '' },
      { id: 'alex', name: 'Алекс', roleId: 'researcher', model: 'default', notes: '' },
      { id: 'vera', name: 'Вера', roleId: 'executor', model: 'default', notes: '' },
      { id: 'oleg', name: 'Олег', roleId: 'reviewer', model: 'default', notes: '' },
    ],
  }],
  cli: { command: 'gigacode', timeoutSeconds: 180 },
};
