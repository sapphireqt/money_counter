# Family Finance — Phase 1 recovery audit v1

Дата аудита: 2026-07-16
Исходный rejected checkpoint: `checkpoint/phase1-rejected-2026-07-16` (`2257d84`)
Recovery branch: `recovery/phase1-acceptance-v2`

## Граница сравнения

Аудит сравнивает rejected checkpoint с последним production-коммитом до Phase 1 — `16ede2c` — и с:

- `family_finance_main_screen_prototype_v34_unified_content_grid.html`;
- `family-finance-codex-phase1-ui-and-operations-brief-v1.md`;
- `family-finance-approved-copy-phase1-v1.md`;
- действующей production-моделью, API и импортом.

Импорт остаётся существующей production-функцией. Его API, parsing и поведение не входят в recovery; допустимо только вернуть уже существующий entry point в отдельный контейнер и убрать import controls из operation/transfer forms.

## Стек и устройство затрагиваемой части

- UI: React 19 / Next 16-совместимый `vinext`, основной client component — `app/money-counter.tsx`.
- Стили: один глобальный `app/globals.css`; rejected Phase 1 добавил второй набор tokens и 2314 строк prototype-подобных правил после 1915 строк legacy CSS.
- Backend: route handlers в `app/api`, Drizzle ORM и D1/SQLite. Схема БД Phase 1 не менялась.
- Предметная логика: деньги/даты в `lib/finance.ts`, прогноз в `lib/forecast.ts`, импорт в `lib/import.ts` и `lib/pdf.ts`; rejected Phase 1 добавил `lib/operations.ts` и `lib/accounts-panel.ts`.
- Проверки: ESLint, TypeScript через `tsc --noEmit`, `vinext build`, Node test runner (`tests/*.test.ts`). E2E-инфраструктуры в repository до recovery нет.

## Что было заменено или добавлено в rejected diff

| Область | Rejected реализация |
|---|---|
| Главный экран | Добавлены unified top/grid, compact metrics, toolbar, сортировка, новая таблица и right rail внутри старого монолитного `MoneyCounter`. |
| Операции | Добавлены create/edit variants, suggestions, additional fields и confirmations, но поверх legacy modal/form primitives. |
| Переводы | Расширены create/link/edit/unlink UI и `/api/transfers`; backend можно сохранить, UI требует структурного выравнивания. |
| Счета | Добавлен selector 9/expand/session/negative-priority в `lib/accounts-panel.ts`; визуальные правила частично исправлены отдельным последующим коммитом. |
| Диаграмма | Добавлен новый donut, но dataset ошибочно обрезается/агрегируется до четырёх элементов. |
| Состояния | Частично добавлены loading/empty/no-results/error, без системной visual acceptance. |

## Где осталась legacy-композиция

1. `app/globals.css` содержит два `:root`, два body/theme слоя и одновременно legacy и Phase 1 selectors. Phase 1 rules перекрывают legacy source-order/specificity, а не изолируют его.
2. Sidebar использует legacy DOM-классы `sidebar`, `sidebarNav`, `navButton`; внешний вид зависит от поздних overrides.
3. Верхние показатели используют legacy `summaryGrid` и `metric`; workspace — `workspace twoCol`, `mainColumn`, `rightRail`.
4. Toolbar использует legacy `opsToolbar`; таблица одновременно `opsTable phase1OpsTable`, wrapper — legacy `tableWrap`.
5. В date-sort ветке строки рендерятся отдельным legacy JSX с `amountCell`, `altAmount`, `iconButton`; amount-sort использует новый `renderOperationRow`. Поэтому состояния сортировки имеют разную структуру и стили.
6. Operation/transfer dialogs собраны как `modalOverlay` + `modalCard operationDialog` + `transactionForm phase1TransactionForm`; layout является каскадом legacy rules и overrides.
7. Candidates используют legacy `partnerPicker`, `partnerList`, `partnerCreate`; confirmations частично новые, частично legacy.
8. Import fragment `modalImport` физически расположен после operation form внутри того же dialog.

## Зафиксированные functional FAIL до исправлений

- `Forecast OFF`: `.summaryGrid:not(.withForecast)` оставляет только `var(--left-col)`, справа остаётся пустая область.
- Responsive: при переносе top/right rail компактный forecast скрывается; meaningful content должен оставаться доступным.
- Date-sort и amount-sort используют разные row renderers; это создаёт расхождение transfer/amount/typography и усложняет инварианты.
- Donut использует максимум четыре элемента и создаёт `Остальное`; это нарушает правило “all non-zero slices + top-4 legend”.
- Import UI присутствует в operation modal; пункт импорта открывает ordinary operation form вместо отдельного существующего import flow.
- В account selects неактивные счета остаются в DOM как disabled options вместо отсутствия из options.
- Постоянный helper даты выводится в edit forms; он допустим только при создании.
- Account-invalid validation присутствует, но options, helper/error и некоторые transfer branches не следуют одному selector/variant contract.
- Operation modal create/edit и transfer states не имеют единой prototype-структуры header/body/footer; footer размещён как элемент form-grid.
- Loading/empty/no-results/error реализованы фрагментарно и не покрыты одинаковыми state fixtures/screenshots.
- Нет visual/e2e acceptance для обязательных viewport и состояний.

## Production-модель и конфликты с ТЗ

1. В production перевод хранится двумя transactions, связанными `transferGroup`; это совместимо с UI, но same-currency и cross-currency формы должны явно маппиться на две фактические суммы.
2. Production import уже существует и исторически был встроен в add/edit modal. ТЗ запрещает менять import behavior, поэтому recovery отделяет контейнер/entry point без изменения import API/parsing.
3. Приложение монолитное: main/settings/charts/forecast и все dialogs живут в одном `MoneyCounter`. Полный rewrite рискован; recovery выделяет только Phase 1 view primitives и pure selectors, сохраняя data loading/mutations.
4. Prototype содержит expanded sidebar, QA controls, mock/import screens и responsive `display:none`; brief/recovery явно отменяют эти части. Они не переносятся.
5. Prototype mock chart знает значения всех категорий; production получает реальные агрегаты в разных валютах. Dataset строится после production conversion и должен сохранять все ненулевые категории и точную сумму.
6. API возвращает обычные ошибки request-level, а не раздельные ошибки каждого right-rail блока. Для acceptance нужны корректные доступные states без изменения публичного API.

## Решение по recovery

Полный rollback рискован: rejected diff содержит совместимую backend-логику transfers/suggestions и полезные pure selectors. Минимально рискованный путь:

1. сохранить API и предметные mutation/data-loading ветки;
2. заменить смешанную Phase 1 DOM-композицию едиными явно именованными primitives;
3. оставить legacy styles только для незатрагиваемых tabs, исключив legacy class names из Phase 1 main/forms/transfers;
4. свести row rendering, account availability и chart transforms к одному pure path и покрыть unit/integration tests;
5. добавить dev/test-only deterministic acceptance fixture/state route или эквивалент, не показывая QA controls пользователю;
6. выполнить visual acceptance в реальном Chromium на отдельном fresh D1 и отмечать строки матрицы PASS только после получения парных screenshots и DOM/computed-style assertions.

## Обоснование API, уже добавленного в rejected checkpoint

Recovery не меняет schema и не выполняет migrations. Два API-расширения из rejected Phase 1 сохранены как минимально необходимые для утверждённых сценариев:

- `GET /api/transactions/suggestions?q=…` нужен, потому что существующий production API отдаёт только операции выбранного периода и не может выполнить 12-месячный поиск подсказок с limit 8 без загрузки истории в форму. Recovery ограничил окно двенадцатью месяцами, minimum query — двумя символами, результат — восемью вариантами.
- `GET/PATCH /api/transfers?group=…` нужен для чтения и атомарного сохранения обеих уже связанных сторон в форме `Редактировать перевод`. Production-модель хранит перевод как две строки с `transfer_group`; PATCH обновляет существующие строки и не меняет форму данных остальных endpoints.

Существующие import routes, parsing, schema и пользовательский import flow не изменялись.

## Выполненные recovery passes

### Pass 1 — структура и утечки scope

- Phase 1 main, operation forms и transfer forms используют отдельные `p1*` primitives без legacy class composition.
- Import dialog физически отделён от operation/transfer form; существующий entry point и поведение сохранены.
- Один selector фильтрует account options по дате; неактивные accounts отсутствуют в options.
- Forecast OFF занимает полную content-grid.
- Donut получает все ненулевые категории, legend — только top 4.

### Pass 2 — главный экран

- Зафиксирована сетка `72 / 922 / 18 / 350`, toolbar и table имеют одну ширину.
- Date и amount sorting используют один row renderer; amount modes не создают day groups.
- Responsive переносит forecast и right rail, не скрывая meaningful content.
- Account card приведена к отдельно утверждённой типографике и тональным состояниям.
- Реализованы max 9, session expand state и однократное продвижение невидимого отрицательного счёта.
- При повторной статической сверке найден и исправлен поздний prototype-каскад `.compact-metrics.header-context`: sticky header теперь использует компактные inline-метрики, а не раннюю зелёную card-композицию.

### Pass 3 — формы

- Create/edit expense/income, helper/error visibility, suggestions, autocategory и additional fields разделены явными branches.
- Тексты взяты из approved copy/prototype; delete confirmation и toast совпадают с source of truth.
- Modal semantics, focus trap, Escape и focus return проверены статическими contract tests.

### Pass 4 — transfers

- Same-currency create использует одно фактическое amount; cross-currency — `Списано` и `Зачислено`.
- Реализованы candidates, partner creation, linked edit, unlink и confirmations.
- Изолированный API smoke проверяет create/read/update/link/unlink, lifetime validation, same-account rejection, categories, notes и attention flag.

### Pass 5 — automated acceptance

- Добавлен `tests/phase1-visual-fixture.mjs`, который намеренно отказывается работать с обычным port 3000 и создаёт данные только в fresh loopback server/D1. Fixture прошёл: 14 accounts, 12 активных в июле 2026, отрицательный overflow, zero/native-currency states и 8 ненулевых chart buckets (7 managed categories + «Без категории»).
- Добавлены pure unit tests и статические DOM/CSS contract tests; после post-acceptance исправления toolbar scope — всего 25 тестов.
- Добавлен full-screen main error/retry state по prototype; table error остаётся block-level.
- После прямого разрешения пользователя установлен standalone Playwright и использован Playwright-managed Chromium. Visual runner открывает сам prototype v34 и production на isolated server, создаёт сопоставимые состояния и парные full-page screenshots.
- Проверены 60 пар: обязательные 1440×900 и 1600×1000 для desktop-состояний, а также 1360×900 и 1024×900 для responsive. Все строки — PASS; report дополнительно содержит geometry, DOM, computed-style, copy и business-state assertions.
- Runner проверяет PNG на near-black compositor tiles и повторяет capture до пяти раз; финальный прогон прошёл с первой попытки для всех 120 screenshots.
- Ручным просмотром после прогона перепроверены пары main/accounts, operation modal, transfer partner/linked edit, empty и responsive.

## Pass gates

- Pass 1: structure/scope contracts и соответствующие paired screenshots — PASS.
- Pass 2: desktop/responsive geometry, table/sorting, accounts/session rules и chart — PASS.
- Pass 3: create/edit variants, copy, suggestions, autocategory, additional fields и accessibility contracts — PASS.
- Pass 4: transfer visuals + isolated API create/read/update/link/unlink smoke — PASS.
- Pass 5: исходный Playwright run 60/60, текущие tests 25/25, lint, typecheck, production build и `git diff --check` — PASS.

## Финальные доказательства

- Acceptance matrix: `family-finance-phase1-acceptance-matrix-v2.md`.
- Machine-readable visual report: `artifacts/phase1-acceptance/report.json`.
- Paired screenshots: `artifacts/phase1-acceptance/prototype/` и `artifacts/phase1-acceptance/production/`.
- Visual scenarios/assertions: `tests/phase1-visual-acceptance.mjs`.
- Deterministic isolated fixture: `tests/phase1-visual-fixture.mjs`.
- Transfer API smoke: `tests/phase1-transfer-api-smoke.mjs`.

Ветка остаётся `recovery/phase1-acceptance-v2`; merge, commit, push, deploy и migrations не выполнялись. Порт 3000 и его D1 не использовались visual/API acceptance.

## Post-acceptance correction — 2026-07-16

- По пользовательскому замечанию возвращён scope-select `Текущий период / Вся история` слева от поиска; его внешний вид взят из prototype v34.
- History scope включается только при непустом поиске или активном production-фильтре; summary/right rail остаются привязаны к выбранному периоду.
- Visual harness дополнен сценарием `scope-history`, fixture — исторической строкой Carrefour.
- Повторный screenshot-run не выполнен: in-app Browser discovery вернул пустой список, standalone Chromium запрещён текущей sandbox-политикой. Старый report 60/60 явно относится к состоянию до этой коррекции.
