# Family Finance — convergence pass после второй реализации Phase 1

Текущая версия уже заметно ближе к prototype v34, поэтому не начинай ещё один полный rewrite. Нужен системный convergence pass: устранить общие причины расхождений, затем прогнать автоматизированную приёмку.

Используй вместе:

- `family-finance-main-screen-prototype-v34-unified-content-grid.html`;
- `family-finance-codex-phase1-ui-and-operations-brief-v1.md`;
- `family-finance-approved-copy-phase1-v1.md`;
- screenshots:
  - `html.png` — визуальная цель;
  - `prod.png` — текущий production;
  - `unlink.png` — текущая поломка confirmation modal.

Не проси пользователя вручную искать все оставшиеся дефекты.

---

# 1. Сначала проверь, почему весь production визуально ужат

По screenshots production выглядит системно плотнее prototype:

- мельче типографика;
- ниже строки;
- компактнее cards/toolbar;
- больше элементов помещается по высоте;
- modal content сильнее сжимается и начинает переносить валюту.

Не исправляй это увеличением отдельных font-size на глаз.

## 1.1. Сравнение должно происходить в одинаковых условиях

Автоматизированно открой prototype и production:

- одинаковый CSS viewport;
- browser zoom 100%;
- одинаковый `deviceScaleFactor`;
- одинаковая font availability;
- одинаковый locale;
- без browser extensions.

Рекомендуемые CSS viewport:

- `1440 × 900`;
- `1600 × 1000`.

Raw pixel dimensions PNG не использовать как доказательство масштаба: retina/DPR может удваивать screenshot.

Зафиксируй для обеих страниц:

```js
{
  innerWidth,
  innerHeight,
  devicePixelRatio,
  visualViewportScale: visualViewport?.scale,
  rootFontSize: getComputedStyle(document.documentElement).fontSize,
  bodyFontSize: getComputedStyle(document.body).fontSize,
  bodyLineHeight: getComputedStyle(document.body).lineHeight
}
```

Проверь production CSS на:

- `zoom`;
- `transform: scale(...)`;
- уменьшенный root `font-size`;
- `%` font-size на `html`;
- global density/compact mode UI library;
- размеры в `rem`, рассчитанные от другого root;
- глобальные `line-height`;
- CSS reset, переопределяющий buttons/inputs;
- legacy tokens, используемые вместо prototype tokens.

## 1.2. Geometry/style contract

Сравни `getBoundingClientRect()` и computed style representative-элементов. Создай automated geometry test.

Целевые значения из prototype v34:

```text
body font-size:            14px
sidebar width:             72px

left column:               922px
right column:              350px
content gap:               18px
content max:               1346px

table width:               922px
table radius:              16px
table columns:             24 / 132 / 300 / 244 / 104 / 42
table column gap:          10px

table header padding:      10px 12px
table header font:         11.5px / 600

ordinary row min-height:   44px
ordinary row padding:      8px 12px
transfer row min-height:   52px

account font:              12.5px / 400
description font:          13.5px / 500
operation amount font:     13.5px / 500
category font:             12.5px / 400
day date font:             14px / 700
day amount font:           15px / 700

operation modal width:     660px
operation modal radius:    16px
operation header height:   60px
operation field height:    42px
operation field font:      13px

unlink confirm width:      520px
unlink confirm padding:    24px
```

Не обязательно hardcode все значения в разных компонентах. Вынеси их в единые tokens/variants. Но итоговые bounding boxes должны совпадать с prototype.

## 1.3. Scale gate

До исправления отдельных компонентных багов добейся, чтобы:

- главный screen при одинаковом viewport занимал сопоставимую площадь;
- количество строк, помещающихся по высоте, было сопоставимо;
- metrics, toolbar, table rows и right cards не выглядели как compact-density версия;
- operation modal совпадал с prototype по общей геометрии.

Приложи парные screenshots и computed-style diff.

---

# 2. Исправь sticky-контексты системно

Не чинить table header и right column двумя случайными `position: sticky`.

Проверь все ancestors на:

- `overflow: hidden`;
- `overflow: auto`;
- `overflow: clip`;
- `transform`;
- `filter`;
- `contain`;
- неправильную фиксированную высоту;
- отдельный scroll container.

Любой из этих факторов может изменить или сломать sticky containing block.

## 2.1. Заголовок таблицы

Требование:

- header таблицы закрепляется при вертикальном scroll страницы;
- не исчезает под compact metrics/toolbar;
- имеет непрозрачный background;
- сохраняет ширину и сетку колонок;
- не обрезается border-radius контейнера.

Ориентир prototype:

```css
position: sticky;
top: 74px;
z-index: 20;
```

При появлении compact metrics итоговый top-offset должен учитывать её фактическую высоту. Не полагаться на магическое число, если production header отличается: используй общий CSS variable.

Если `overflow: clip/hidden` table shell ломает sticky:

- отдели sticky header от clipping shell;
- либо перенеси radius/border на wrapper, который не становится неправильным scroll container;
- не отключай sticky ради сохранения radius.

## 2.2. Правая колонка

Требование:

- accounts + category chart образуют один sticky stack;
- stack закрепляется как единый блок;
- `align-self: start`;
- обычный top около `10px`;
- после появления compact header top сдвигается ниже неё;
- если stack выше доступной высоты viewport, sticky отключается и блок идёт обычным потоком;
- внутренний scroll right cards не добавлять.

Используй измерение фактической высоты stack и доступного viewport. Пересчитывай через `ResizeObserver` и resize.

---

# 3. Исправь переводы как структуру данных и component contract

Текущая ошибка не является вопросом spacing.

## 3.1. Строка перевода

В колонке `Счёт` должно быть:

```text
KAST AK → BBVA
```

или соответствующая реальная пара:

```text
{sourceAccount} → {destinationAccount}
```

В колонке `Сумма` должны быть только денежные значения:

- первая строка: сумма списания;
- вторая строка: `→` и сумма зачисления, если она отличается/нужна;
- название счёта назначения не должно находиться в amount cell.

Не собирай transfer row из generic expense row с destination account, вставленным в произвольную secondary line.

Создай/исправь явную presentation model:

```ts
{
  accountLabel: `${sourceAccount} → ${destinationAccount}`,
  debitAmount,
  debitCurrency,
  creditAmount,
  creditCurrency
}
```

И отдельный `TransferRow`/variant с тестами.

## 3.2. Один Money component

Все суммы в таблицах, карточках и modal confirmations должны использовать единый Money component/formatter.

Инварианты:

- число и currency symbol/code не разрываются переносом;
- `white-space: nowrap`;
- tabular numerals;
- валюта не оказывается на отдельной строке;
- minus/plus соответствует product rules;
- компонент способен показать secondary amount меньшим стилем.

Не исправляй unlink modal локальным `<br>` или увеличением card width.

---

# 4. Исправь unlink confirmation modal структурно

На `unlink.png` видны:

- выход второй card за границы modal;
- перенос символа валюты на отдельную строку;
- недостаточная устойчивость grid;
- amount layout, зависящий от абсолютного позиционирования/случайной ширины.

Цель prototype:

```text
modal width: 520px
pair: 2 equal columns
gap: 10px
```

Требование к реализации:

```css
.confirmPair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.confirmCard {
  min-width: 0;
}

.confirmAmount {
  white-space: nowrap;
  justify-self: end;
}
```

Не использовать absolute positioning суммы, если оно вызывает overlap.

Внутри каждой card:

- label;
- account name;
- date/destination metadata;
- amount как один неразрывный Money component.

При очень длинных account names:

- account name ellipsis;
- amount не сжимается и не переносится;
- card не выходит за modal.

Добавь tests минимум для:

- EUR;
- USD;
- RUB;
- четырёхзначной и шестизначной суммы;
- длинного account name;
- mixed currency pair.

---

# 5. Визуальная разница html.png / prod.png

После исправления global scale сделай overlay/diff:

1. prototype screenshot;
2. production screenshot;
3. image diff;
4. список крупнейших областей расхождения.

Не пытайся получить нулевой pixel diff из-за разных данных. Сравнивай layout anchors:

- верх period controls;
- metrics panel;
- forecast;
- toolbar;
- table x/y/width;
- right column x/y/width;
- row heights;
- chart diameter;
- modal bounds.

Введи geometry assertions с допустимым отклонением:

- major widths/heights: `±2px`;
- positions/gaps: `±3px`;
- fonts/line-heights: exact computed values;
- цвет: exact token;
- shadow rendering можно проверять screenshot, не DOM assertion.

---

# 6. Не переходить сразу к случайному point QA

Порядок:

## Pass A — global normalization

- viewport/DPR parity;
- root/body typography;
- design tokens;
- component density;
- main geometry;
- modal geometry.

## Pass B — layout mechanics

- sticky table header;
- sticky right stack;
- forecast on/off;
- responsive stacking.

## Pass C — shared semantic components

- Money;
- TransferRow;
- AccountPair;
- confirmation card.

## Pass D — state matrix

Прогнать существующую Phase 1 acceptance matrix по всем forms/states.

Только после Pass A–C имеет смысл исправлять отдельные визуальные мелочи. Иначе они будут постоянно появляться заново из-за общих tokens и layout primitives.

---

# 7. Definition of done этого convergence pass

Не показывай результат пользователю, пока:

- production и prototype открыты в одинаковых условиях;
- global scale gate пройден;
- geometry test проходит;
- table header sticky работает;
- right stack sticky работает;
- transfer account pair находится в account column;
- amount column не содержит account name;
- currency нигде не переносится отдельно от числа;
- unlink modal не имеет overflow;
- screenshots prototype/production/diff приложены;
- lint/typecheck/build проходят;
- все ранее зелёные acceptance tests остались зелёными.

В отчёте покажи:

1. найденную первопричину визуального уменьшения;
2. какие global tokens/layout primitives исправлены;
3. какие shared components созданы/исправлены;
4. парные screenshots;
5. geometry/computed-style report;
6. оставшиеся точечные расхождения, если они действительно не блокирующие.
