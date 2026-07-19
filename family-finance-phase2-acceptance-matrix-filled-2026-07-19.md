# Family Finance — Phase 2: acceptance matrix (заполнено)

Branch `phase2-import`, commit `23c42c4`. 72/72 tests, lint/tsc/build exit 0.
`PASS` — выполнено; `PASS*` — выполнено, но с оговоркой (см. сноску); `MANUAL` — требует ручного прогона на production (§8 handoff), локальный эквивалент подтверждён.

| ID | Проверка | Status | Evidence |
|---|---|---|---|
| S-01 | База ветки | PASS | `phase2-import` от `main` (содержит `bcc516c`) |
| S-02 | Scope (главный экран не переделан) | PASS | diff: тронут только import-модал + `.im-*` CSS |
| S-03 | Schema без migration | PASS | `git diff main…HEAD -- db/` пуст |
| S-04 | Нет success-screen/undo/history | PASS | diff + screenshots |
| A-01 | Audit parser/dedupe/write | PASS | handoff §3 |
| A-02 | Форматы PDF/CSV/TSV | PASS | tests + screenshots |
| A-03 | Автотесты не пишут в prod | PASS | чистые libs + изолированная miniflare; handoff §5 |
| UI-01 | Точка входа `+ Добавить → Импортировать операции` | PASS | screenshot |
| UI-02 | Отдельная modal «Импорт выписки» | PASS | screenshot 01 |
| UI-03 | Stepper 3 шага, active/done | PASS | screenshots 01–06 |
| UI-04 | Ширина/геометрия v34.1 | PASS | `.im-dialog width:min(660px)` (CSS-тест) + screenshots |
| UI-05 | Нет double-scroll | PASS | `.review-fixed` single-scroll (CSS-тест) + screenshots |
| U1-01 | Dropzone внешний вид/copy | PASS | screenshot 01 |
| U1-02 | `PDF, CSV, TSV · до 20 МБ` | PASS | screenshot 01 |
| U1-03 | File card + metadata + «Заменить файл» | PASS | screenshot 02 |
| U1-04 | Semantic count (операции, не строки) | PASS | «14 операций», unit `summarizeOperations` |
| U1-05 | Без счёта нельзя продолжить | PASS | `nextDisabled` (canLeaveStep1) |
| U1-06 | Зелёное подтверждение валюты | PASS | screenshot 02 |
| U1-07 | Loading `Читаем выписку…`, дальше нельзя | PASS | screenshot 10 |
| U1-08 | Read error, можно заменить | PASS | screenshot 13 |
| U1-09 | Empty; all-duplicates ≠ empty | PASS | screenshot 12; empty только при 0 нормализованных ops (до поиска дублей) |
| U1-10 | Currency mismatch, переход заблокирован | PASS | screenshot 11 |
| P-01 | TSV читается | PASS | test |
| P-02 | CSV читается | PASS | `large.csv` (comma) → review; авто-делимитер |
| P-03 | PDF KBank без OCR | PASS | test + screenshot 06 |
| P-04 | Файл >20 МБ отклоняется до parsing | PASS | `file.size` guard в `handleFile` |
| P-05 | Нет encoding-селектора | PASS | screenshots (нет контрола) |
| P-06 | Beginning Balance не операция | PASS | test (10 ops) |
| P-07 | Headers/summary не операции | PASS | test |
| P-08 | Completed Date по умолчанию | PASS | test + screenshot 03 |
| P-09 | Started Date доступна и в dedupe | PASS | test |
| P-10 | PDF Date без времени | PASS | test |
| P-11 | Signed amount: −/+ | PASS | test |
| P-12 | PDF Withdrawal/Deposit | PASS | test |
| P-13 | Amount=0+Fee → один расход | PASS | test |
| P-14 | Amount≠0+Fee → две операции | PASS | test «non-zero amount AND a fee» |
| P-15 | Error Correction — отдельное поступление | PASS | test |
| P-16 | Ref Code/Channel не в description | PASS | test |
| P-17 | Получатель перевода сохраняется | PASS | test («To BAY X8078…») |
| P-18 | COMPLETED — обычная | PASS | test |
| P-19 | PENDING — problem row | PASS | screenshot 09 + test |
| P-20 | FAILED — problem row | PASS | screenshot 09 |
| P-21 | REVERTED — problem row | PASS | screenshot 09 |
| M-01 | TSV mapping 3 строки | PASS | screenshot 03 |
| M-02 | PDF mapping Date/Descriptions/Withdrawal | PASS | screenshot 04 |
| M-03 | Реальные примеры | PASS | screenshots 03/04 |
| M-04 | Inline-редактор раскрывает одну строку | PASS | screenshot 03b; `openEditor` single |
| M-05 | Fee note только при наличии | PASS | test + screenshot 03 |
| R-01 | ≤25 — все | PASS | screenshot 05 |
| R-02 | >25 — первые 10 | PASS | screenshot 07 |
| R-03 | Problem rows первыми | PASS | screenshots 09/14 |
| R-04 | Full-list link только total>25, слева | PASS | код + screenshot 07 |
| R-05 | Одна итоговая строка | PASS | screenshots |
| R-06 | Кнопка `Импортировать` без count | PASS | UI-contract test |
| F-01 | Поиск в полном списке | PASS | screenshot 08b |
| F-02 | Фильтры в полном списке | PASS | test (4 опции) |
| F-03 | Sticky header | PASS | CSS-тест + screenshot 08 |
| F-04 | Count `Показано X из Y` | PASS | screenshot 08 |
| I-01 | Duplicate reason точный | PASS | screenshot 14 |
| I-02 | Duplicate actions Импортировать/Исключить | PASS | screenshot 14 |
| I-03 | Date issue: select + Исключить | PASS* | реализовано; fixtures не триггерят (handoff §7) |
| I-04 | Amount issue: select + Исключить | PASS* | реализовано (KBank); fixtures не триггерят |
| I-05 | Bank state issue тем же паттерном | PASS | screenshot 09 |
| I-06 | Final import disabled до решения | PASS | e2e: disabled с 14 дублями, enabled после exclude |
| I-07 | Решено/Готово/Изменить | PASS | screenshot 09b |
| I-08 | Решённая строка не переезжает | PASS | screenshot 09b (порядок сохранён) |
| I-09 | Exclude → count уменьшается | PASS | e2e: 15 → 1 |
| D-01 | Dedupe только в выбранном счёте | PASS | `existing` = один accountId |
| D-02 | Направление обязательно совпадает | PASS | test |
| D-03 | Фактическая сумма совпадает | PASS | test |
| D-04 | ±3 дня Started/Completed | PASS | test (граница +3 in, +4 out) |
| D-05 | Description не обязателен (EasyPark→Парковка) | PASS | test |
| D-06 | Видны другие кандидаты | PASS | test (sorted list) |
| D-07 | Противоположные знаки — не дубли | PASS | test |
| D-08 | Строки файла — не дубли друг друга | PASS | test (empty existing → 0 dupes) |
| FX-01 | Original TSV — 14 операций | PASS | test |
| FX-02 | Original TSV — 14 дублей в prod-preview | MANUAL | локально 14 dup-blocks подтверждены (e2e) |
| FX-03 | Original PDF — 10 операций | PASS | test |
| FX-04 | Original PDF — 10 дублей в prod-preview | MANUAL | механизм подтверждён локально |
| FX-05 | Check TSV — 14 дублей + 1 новая | PASS/MANUAL | e2e локально: 14 dup + 1 new → exclude → 1; prod = §8 |
| W-01 | Upload не пишет в БД | PASS | клиентский парсинг |
| W-02 | Mapping не пишет | PASS | чистая нормализация |
| W-03 | Preview не пишет | PASS | только read-only GET |
| W-04 | Full list не пишет | PASS | те же данные |
| W-05 | Submit пишет только included | PASS | test + e2e |
| W-06 | Server revalidation | PASS | `import-commit` test (account/currency/date/lifetime) |
| W-07 | Atomicity all-or-none | PASS | `d1.batch` (документировано) |
| W-08 | Claude сам не запускает prod-write | PASS | не запускалось; инструкция §8 |
| Q-01 | Phase 1 tests проходят | PASS | 38/38 |
| Q-02 | Unit tests parser/dedupe | PASS | 34 Phase 2 тестов |
| Q-03 | Lint exit 0 | PASS | log |
| Q-04 | Typecheck exit 0 | PASS | log |
| Q-05 | Build exit 0 | PASS | log |
| Q-06 | Focus trap, labels, Escape, focus return | PASS* | реализовано (trap/Escape/lock/return-focus + `<label>`); полный a11y-аудит не проводился |
| Q-07 | Handoff + screenshots | PASS | этот пакет |
