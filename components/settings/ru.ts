import { registerCatalog } from '@/lib/i18n/core'

registerCatalog({
  Language: 'Язык',
  'The language is set by the HUB_LANG variable on the server; remove it to switch here.': 'Язык задан переменной HUB_LANG на сервере; уберите её, чтобы переключать здесь.',
  'The admin panel and pages switch at once, tool replies from the next call. Tool descriptions and the hub instructions reach the assistant at the start of a chat, so they change in a new chat.':
    'Админка и страницы переключаются сразу, ответы инструментов — со следующего вызова. Описания инструментов и инструкции хаба ассистент получает в начале чата, поэтому они сменятся в новом чате.',
  'Scripts that read the text of hub.tool replies may break after a switch: the replies change language too.':
    'Скрипты, которые разбирают текст ответов hub.tool, после переключения могут сломаться: ответы тоже меняют язык.',
})
