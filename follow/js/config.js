/*
 * Настройки лендинга FOLLOW.
 */
window.FOLLOW_CONFIG = {
  // Адрес сервера заявок и записей (functions/api или server/server.js).
  // '' — тот же домен. null — сервера нет (страница открыта с диска): заявки остаются в браузере.
  apiBase: location.protocol === 'file:' ? null : '',

  // Адрес сайта для реферальных ссылок
  siteUrl: 'https://follow.com.ai/',

  // Номер счётчика Яндекс Метрики (Вебвизор, цели из ТЗ). null — Метрика не подключается.
  metrikaId: null,

  // ТЗ: необязательные счётчики — только после согласия в cookie-баннере
  requireConsent: true,

  // Хранить записи сессий в localStorage посетителя (для проверки без сервера)
  localRecordings: location.protocol === 'file:',

  // Ограничения записи
  maxDurationMs: 30 * 60 * 1000,
  maxEvents: 30000,
  flushIntervalMs: 3000
};
