# Family Finance — Phase 1 acceptance matrix v2

Заполнено по итогам convergence pass. Скриншоты сняты автоматически
(`npm run test:visual` → `tests/phase1-visual-acceptance.mjs`) при 1440×900 и
1600×1000, DPR 1: пути ниже — пары 1440×900, рядом с каждой лежит
`…-1600x1000.png`. Полный протокол: `artifacts/phase1-acceptance/report.json`
(62 пары, 373 проверки, 0 FAIL); геометрия: `artifacts/phase1-acceptance/geometry-report.md`;
pixel-diff ключевых пар: `artifacts/phase1-acceptance/diff/`.

`P/` = `artifacts/phase1-acceptance/prototype/`, `B/` = `artifacts/phase1-acceptance/production/`.

| Область | Состояние | Ожидаемое поведение | Prototype screenshot | Production screenshot | Test | Result |
|---|---|---|---|---|---|---|
| Sidebar | Default | Всегда 72px, expanded отсутствует | P/main-forecast-on-1440x900.png | B/main-forecast-on-1440x900.png | main-forecast-on: «sidebar is exactly 72px», «sidebar has no expand control» | PASS |
| Main | Forecast ON | Показатели слева, прогноз справа | P/main-forecast-on-1440x900.png | B/main-forecast-on-1440x900.png | main-forecast-on: колонки 922/350, gap 18 | PASS |
| Main | Forecast OFF | Показатели растягиваются на всю content width | P/main-forecast-off-1440x900.png | B/main-forecast-off-1440x900.png | main-forecast-off: «facts panel fills the content width», одна grid-колонка | PASS |
| Main | Narrow desktop | Прогноз переносится, не скрывается | P/responsive-wrap-1360x900.png | B/responsive-wrap-1360x900.png | responsive-wrap: «forecast moves below facts», «forecast remains visible» | PASS |
| Main | Narrow desktop | Right column переносится под таблицу | P/responsive-wrap-1024x900.png | B/responsive-wrap-1024x900.png | responsive-wrap: «right rail moves below table column», accounts/chart visible, нет h-scroll | PASS |
| Toolbar | Default | Ширина ровно как у таблицы | P/main-forecast-on-1440x900.png | B/main-forecast-on-1440x900.png | main-forecast-on + filters-open: «toolbar equals table width» | PASS |
| Filters | Existing production behavior | Логика не изменена, внешний вид prototype | P/filters-open-1440x900.png | B/filters-open-1440x900.png | filters-open: панель открывается, производственный набор из 3 select | PASS |
| Sorting | Дата ↓ | Группировка по дням | P/sorting-date-1440x900.png | B/sorting-date-1440x900.png | sorting-date + unit «amount sorting is absolute and date sorting restores day order» | PASS |
| Sorting | Сумма ↓ | Без группировки, дата в строке | P/sorting-amount-desc-1440x900.png | B/sorting-amount-desc-1440x900.png | sorting-amount-desc | PASS |
| Sorting | Сумма ↑ | Без группировки, дата в строке | P/sorting-amount-asc-1440x900.png | B/sorting-amount-asc-1440x900.png | sorting-amount-asc | PASS |
| Table | Long day | Плотность и separators как prototype | P/table-long-day-1440x900.png | B/table-long-day-1440x900.png | table-long-day; geometry-report §4 (строка 44px, разделители #f3f4f7/var(--line)) | PASS |
| Table | Income | Зелёный плюс | P/table-income-1440x900.png | B/table-income-1440x900.png | table-income: «income has green plus» (#2e8a5c, цвет строки прототипа) | PASS |
| Table | Expense | Без минуса | P/table-expense-1440x900.png | B/table-expense-1440x900.png | table-expense: «expense has no minus» | PASS |
| Table | Transfer | Двухстрочная структура | P/table-transfer-1440x900.png | B/table-transfer-1440x900.png | table-transfer: пара «A → B» в колонке счёта; видимость строк — только от валют (блок: src≠display ∨ src≠dst; «→»: src≠dst). USD→EUR: main EUR + списание USD + «→ EUR», 52px; EUR→USD: main EUR + списание EUR + «→ USD», 52px; EUR→EUR: только main, 44px; unit «transfer amount visibility depends on currencies only» | PASS |
| Accounts card | Default | Только отображаемые production-счета | P/accounts-default-1440x900.png | B/accounts-default-1440x900.png | accounts-default + unit accounts-panel (лимит 9, скрытый отрицательный, lifetime) | PASS |
| Chart | Default | Все категории в donut, top 4 в legend | P/chart-default-1440x900.png | B/chart-default-1440x900.png | chart-default + unit «category presentation keeps every non-zero slice…» | PASS |
| Operation form | New expense | Нет import UI, helper даты виден | P/operation-new-expense-1440x900.png | B/operation-new-expense-1440x900.png | operation-new-expense + contract «no import controls» | PASS |
| Operation form | New income | Нет import UI | P/operation-new-income-1440x900.png | B/operation-new-income-1440x900.png | operation-new-income | PASS |
| Operation form | Edit expense | Нет import UI, постоянного date-helper нет | P/operation-edit-expense-1440x900.png | B/operation-edit-expense-1440x900.png | operation-edit-expense | PASS |
| Operation form | Edit income | Нет import UI, постоянного date-helper нет | P/operation-edit-income-1440x900.png | B/operation-edit-income-1440x900.png | operation-edit-income | PASS |
| Operation form | Invalid account | Точный error copy, save blocked | P/operation-invalid-account-1440x900.png | B/operation-invalid-account-1440x900.png | operation-invalid-account: «Этот счёт недоступен на выбранную дату…», submit disabled | PASS |
| Account dropdown | New operation | Только активные на дату счета | P/operation-new-expense-1440x900.png | B/operation-new-expense-1440x900.png | contract «account options contain only accounts active on the selected date» + «all account pickers use the active-on-date selector» | PASS |
| Suggestions | 2 symbols | Debounce 250ms, max 8, 12 months | P/operation-suggestions-1440x900.png | B/operation-suggestions-1440x900.png | operation-suggestions + unit operations.test.ts (окно 12 мес, 2 символа, cap 8) | PASS |
| Transfer | Same currency | Одно поле суммы | P/transfer-same-currency-1440x900.png | B/transfer-same-currency-1440x900.png | transfer-same-currency | PASS |
| Transfer | Different currency | Списано + Зачислено | P/transfer-different-currency-1440x900.png | B/transfer-different-currency-1440x900.png | transfer-different-currency | PASS |
| Transfer | Candidates | Структура и copy как prototype | P/transfer-candidates-1440x900.png | B/transfer-candidates-1440x900.png | transfer-candidates | PASS |
| Transfer | Edit linked | Две стороны, общий banner | P/transfer-linked-edit-1440x900.png | B/transfer-linked-edit-1440x900.png | transfer-linked-edit | PASS |
| Transfer | Unlink | Две обычные операции после подтверждения | P/transfer-unlink-confirm-1440x900.png | B/transfer-unlink-confirm-1440x900.png | transfer-unlink-confirm: карточки в границах модала, суммы в одну строку; grid repeat(2, minmax(0,1fr)) — contract | PASS |
| State | Loading | Skeleton без layout shift | P/state-loading-1440x900.png | B/state-loading-1440x900.png | state-loading | PASS |
| State | Empty | Корректный empty state | P/state-empty-1440x900.png | B/state-empty-1440x900.png | state-empty | PASS |
| State | No results | Reset action | P/state-no-results-1440x900.png | B/state-no-results-1440x900.png | state-no-results | PASS |
| State | Error | Retry action | P/state-error-1440x900.png | B/state-error-1440x900.png | state-error | PASS |

## Автоматические инварианты

- [x] В DOM operation modal отсутствуют import controls — contract «operation and transfer forms contain no import controls».
- [x] В account options отсутствуют счета, неактивные на выбранную дату — contract + unit selectActiveAccountsOn.
- [x] Количество chart slices равно количеству категорий с ненулевым расходом — unit buildCategoryPresentation + chart-default.
- [x] Legend содержит не более 4 крупнейших категорий — unit + chart-default.
- [x] Сумма chart slices равна общей сумме расходов — unit totalCents + chart-default центр donut.
- [x] Forecast OFF не оставляет пустую grid-column — main-forecast-off «summary has a single grid column».
- [x] Expense visual amount не содержит ведущий минус — table-expense.
- [x] Income visual amount содержит `+` — table-income.
- [x] Amount sort отключает day groups — sorting-amount-desc/asc + unit.
- [x] Date sort восстанавливает day groups — sorting-date + unit.
- [x] Phase 1 не меняет import behavior/API — import-роут и lib/import.ts не тронуты (git diff), contract «no import controls».
- [x] Lint проходит.
- [x] Typecheck проходит.
- [x] Build проходит.
