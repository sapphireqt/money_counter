# Handoff — Family Finance **Phase 2: импорт банковских выписок**

_Дата: 2026-07-19_

## 1. Branch / commit

| | |
|---|---|
| **Branch** | `phase2-import` (создана от `main`, которая содержит принятый Phase 1 `bcc516c`) |
| **Commit** | `23c42c4` — _Add Phase 2 bank-statement import (file/account → mapping → review)_ |
| **База** | `main` HEAD `3fc131d` (Phase 1 + D1 backup tooling) |
| **Schema** | не менялась (`db/` в диффе пуст) |
| **Не запушено / не задеплоено** | по умолчанию, ждёт решения (см. §9) |

## 2. Изменённые файлы (13, +3101 / −447)

| Файл | Что |
|---|---|
| `lib/import-preview.ts` **(new, 549)** | Чистая Phase 2-нормализация + контракт дублей |
| `lib/import-commit.ts` **(new, 178)** | Чистый планировщик финальной записи (ревалидация) |
| `lib/import.ts` (+11) | `.ts`-импорты, `ParsedRow.amountAltCents?`, `export classifyDirection` |
| `lib/pdf.ts` (+22) | KBank-описание Phase 2 (Descriptions + полезные Details, без Ref Code/Channel) |
| `app/api/import/route.ts` (+123/−) | forced-путь через `planForcedImport` + opt-in `skipDedupe`; legacy multi-account путь без изменений |
| `app/money-counter.tsx` (+1508/−447) | Компонент `ImportModal` (3 шага + полный список + edge-состояния); старая одношаговая модалка удалена; точка входа не тронута |
| `app/globals.css` (+591) | Все `.im-*` стили из v34.1 + примитивы `.op-button`/`.op-control` |
| `tests/import-preview.test.ts` **(new)** | parser/normalization/fee/date/state/dedupe (17 тестов) |
| `tests/import-commit.test.ts` **(new)** | write-plan/ревалидация/skipDedupe (5) |
| `tests/phase2-import-ui-contract.test.ts` **(new)** | Phase 2 UI-инварианты (12) |
| `tests/fixtures/*` **(new)** | KBank PDF (извлечённые позиции текста) + оба TSV для тестов |

## 3. Audit существующего import-кода (read-only, до переделки)

- **Форматы**: CSV/TSV (`lib/import.ts` — авто-делимитер, quote-aware парсер, толерантный header-mapping EN/RU/ES/DE/FR/IT, split debit/credit, signed vs direction-column, fee) и PDF **только KBank/K PLUS** (`lib/pdf.ts` — реконструкция таблицы по x-полосам, знак из дельты running-balance, pdfjs извлекает позиции в браузере).
- **Нормализация (до Phase 2)**: `buildRows` возвращал `ParsedRow` с **signed** amountCents и **вычитал fee из основной суммы** (`base -= fee`) — это противоречит Phase 2 (fee должен быть отдельной операцией). Поэтому Phase 2-нормализация написана заново в `lib/import-preview.ts`, а движки парсинга переиспользованы.
- **Дедуп**: `POST /api/import` строит fingerprint `accountId|date|amountCents|description` из **существующих строк БД** и **молча пропускает** совпадения. Это идемпотентность повторного импорта — но НЕ окно ±3 дня и НЕ «description необязателен» из Phase 2. Контракт дублей Phase 2 реализован отдельно (read-only, клиентский) в `findDuplicateCandidates`.
- **Запись в БД**: единственная точка — `POST /api/import`, `d1.batch(inserts)` = одна неявная транзакция (**атомарно**). Есть auto-create счетов при отсутствии `accountId` (используется `scripts/import-sheets.mjs`).
- **Транзакции**: атомарная batch-вставка поддержана инфраструктурой — новую сущность вводить не нужно.
- **UI (до Phase 2)**: одношаговая модалка (`modalImport`) — выбор счёта, drop файла, `<details>`-редактор колонок, flip-знак, превью 8 строк. Точка входа `+ Добавить → Импортировать операции` уже была.
- **Расхождения с brief**: (1) fee вычитался, а не выделялся; (2) не было шагов/mapping-экрана/duplicate-preview/problem-rows/full-list; (3) дедуп по exact-fingerprint, не по ±3-дневному окну. Всё это закрыто Phase 2.

## 4. Реализованные форматы и архитектура парсера

**Конвейер разделён на 4 независимых слоя** (чтобы deferred UX-патч можно было делать без переписывания):

1. **Парсинг** (без БД, браузер): `analyzeImport(text)` (CSV/TSV) и `analyzePdf(pages)` (KBank; pdfjs грузится лениво).
2. **Нормализация превью** (чистая, `lib/import-preview.ts`): `normalizeTextOperations` / `normalizePdfOperations` → `NormalizedOperation[]` (календарная дата + ephemeral started/completed, direction, **положительная абсолютная сумма**, currency, sourceState, issues). Fee → отдельный расход. `State != COMPLETED` → issue `bank_state`.
3. **Поиск дублей** (чистая + read-only fetch): `attachDuplicateCandidates(ops, existing)` где `existing` = `GET /api/transactions?accountId&from&to` (окно = даты файла ±3 дня). Hard-условия: тот же счёт, то же направление, та же абсолютная сумма, дата в ±3 дня от Started **или** Completed. Описание — только ранжирование.
4. **Финальная запись** (`lib/import-commit.ts` + route): клиент шлёт только оставленные операции; `planForcedImport` ревалидирует (счёт/валюта/дата/lifetime/сумма) и пишет одним `d1.batch`. `skipDedupe: true` — решения по дублям приняты пользователем, ничего не отбрасывается молча.

## 5. Подтверждение: нет автоматической записи в production

- Upload / parsing / mapping / preview / поиск дублей / полный список — **не пишут в БД** (чистые функции + один read-only GET).
- Автоматические тесты — только чистые libs и **изолированная локальная miniflare-БД** (свежий `MINIFLARE_STATE_PATH`, порт 3105). Ни один тест не обращается к production.
- Финальная production write-проверка **не запускалась** — инструкция для ручного прогона в §8.

## 6. Проверки

| Команда | Результат |
|---|---|
| `npm run lint` (strict react-compiler) | ✅ exit 0 |
| `npx tsc --noEmit` | ✅ exit 0 |
| `npm test` | ✅ **72/72** (38 Phase 1 + 34 Phase 2) |
| `npm run build` (vinext prod) | ✅ exit 0 (инфо-строка «Some routes could not be classified» — не ошибка) |
| Локальный e2e (Playwright, изолированная D1) | ✅ весь flow; запись 14 операций; повторный `check.tsv` → 14 дублей + 1 новая; после «Исключить» ×14 → итог **1**, кнопка разблокирована; >25 (30 дублей) — все 30 проблемных строк достижимы, без тупика |
| Адверсариальный code-review (workflow, 4 измерения) | ✅ 7 подтверждённых замечаний найдено и **исправлено** (1 HIGH: тупик при >25 + >10 проблем; направление при беззнаковой сумме; необъявленные rejected-строки; гонка dup-поиска; 2 copy; stale-decision при remap) |

Скриншоты (18): шаг 1 до/после, шаг 2 TSV/PDF, review 14, review PDF 10, review >25, полный список (+поиск), review проблемы (+решённая), review дубли (+исключённые), loading/error/empty/currency-mismatch.

## 7. Известные ограничения

- **PDF — только профиль KBank / K PLUS (THB)**. Другой текстовый PDF → состояние «Не удалось прочитать файл». OCR сканов вне scope.
- **Mapping для PDF — read-only** (колонки KBank фиксированы профилем): 3 строки показываются с реальными примерами, но без «Изменить». Для CSV/TSV «Изменить» открывает выбор среди **всех** колонок файла (обобщение мок-списка прототипа).
- **`ambiguous_amount` и `missing_date`** реализованы (UI + логика), но предоставленные fixtures их не триггерят. Для TSV сверка суммы с балансом НЕ делается (во избежание ложных срабатываний) — только для KBank (дельта баланса).
- **Дедуп читает до 500 операций счёта** в окне (лимит `GET /api/transactions`). Для личного счёта за ~месяц этого достаточно; для экстремально плотных периодов часть кандидатов может не попасть.
- **Copy для «резолва» bank_state** («Будет импортирована.») — минимальная необходимая строка, которой нет в approved-copy (approved-copy задаёт только *причину* `Банк отметил операцию как {STATE}` и *duplicate*-строку «…несмотря на возможное совпадение.»). Стоит подтвердить у владельца текстов.
- **Review не обрезает проблемные строки**: при >25 операциях normal-строки показываются первыми 10, а **все** проблемные — целиком (список скроллится), иначе 11-я+ нерешённая проблема была бы недостижима и блокировала импорт (найдено адверсариальным ревью, исправлено).
- **FX-02 / FX-04** (14 дублей TSV и 10 дублей PDF именно в **production**-preview) — проверяются только ручным прогоном на проде; локально механизм подтверждён (§6).
- Экран сортируется «проблемы вперёд»; решённая строка **не переезжает** (остаётся на месте).

## 8. Ручная production-проверка (НЕ запускать без разрешения пользователя)

Перед записью убедиться в свежем бэкапе (есть daily CronJob из `3fc131d`; при сомнении сделать `scripts/` backup вручную).

1. Открыть `+ Добавить → Импортировать операции`.
2. Загрузить `account-statement-phase2-production-check.tsv`.
3. Выбрать правильный **EUR-счёт** (тот, куда уже импортированы 14 оригиналов).
4. Дойти до «Проверка» → убедиться: **14 возможных дублей + 1 новая** (`PHASE 2 IMPORT CHECK`, 12,34 €).
5. Для всех 14 дублей нажать **«Исключить»**.
6. Итог: **«Будут созданы 1 операция…»**, кнопка «Импортировать» активна.
7. Нажать **«Импортировать»** → в списке появляется 1 новая операция; баланс изменился на −12,34 €.
8. Удалить её обычным действием из списка.
9. Убедиться, что список и баланс вернулись к исходному.

(Оригинальные `account-statement-original.tsv` и `kbank-statement-original.pdf` — по 14 и 10 нормализованных операций; в production-preview должны дать 14 и 10 duplicate-кандидатов соответственно, если эти операции уже есть на счёте.)

## 9. Deploy — требуется решение

Проектный дефолт — авто-commit в `main` + деплой. Но brief Phase 2 требует **отдельную ветку**, ручную приёмку по матрице и запрещает Claude самому запускать production-write. Поэтому Phase 2 сейчас **на ветке `phase2-import`, не запушено, не задеплоено**. Нужно ваше решение: мержить в `main` + деплоить сейчас, или после ручной приёмки (§8). См. вопрос в конце сессии.

## 10. Handoff для будущего deferred UX-патча (Phase 2.1)

Патч «полноценные состояния загрузки/ошибки/пустого/mismatch + success-screen + undo» затронет:

- **Компонент**: `ImportModal` в `app/money-counter.tsx` — состояния шага 1 живут в ветвях `status === "loading" | "error" | "empty"` и в баннере `currencyMismatch`; success/undo будут новым состоянием после `handleImport` (сейчас просто закрытие + тост).
- **CSS**: блок `.im-*` в `app/globals.css` (хук `.im-banner`/`.im-banner.warning` уже есть).
- **API**: `POST /api/import` возвращает `createdTransactions` (+ `duplicates`, `rejected`) — success-screen/undo смогут это использовать; для undo потребуется новая сущность/ID группы (сознательно НЕ введена в Phase 2).
- **Чистые слои** (`lib/import-preview.ts`, `lib/import-commit.ts`) переписывать под UX-патч не нужно — они не завязаны на UI.
