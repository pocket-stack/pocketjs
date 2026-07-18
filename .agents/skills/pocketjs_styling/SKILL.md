---
name: pocketjs_styling
description: Guidelines and specifications for compiling Tailwind styles and writing Spec-compliant style objects in PocketJS.
---

# PocketJS Styling & Tailwind Compilation Guidelines

This skill provides the compiler constraints and runtime style property specifications for building user interfaces in PocketJS. Follow these rules to avoid compile-time parser errors and runtime style crashes.

---

## 1. Tailwind Compiler Restrictions (Build-time Class Validation)

The build-time compiler (`compiler/tailwind.ts`) parses static class strings into compiled style records. If a class literal contains any unrecognized utility token, the compiler ignores the entire literal, which leads to a runtime crash (`unknown class ... not in the compiled style table`).

### Text & Font Weights
* **Only `font-bold` is supported.** Do NOT use `font-semibold`, `font-extrabold`, or `font-black`.
* **Only `tracking-wide` is supported.** Do NOT use `tracking-tighter`, `tracking-tight`, etc.
* **Text sizes are restricted to baked font slots:**
  * `text-xs` (12px)
  * `text-sm` (14px)
  * `text-base` (16px)
  * `text-lg` (18px)
  * `text-xl` (20px)
  * `text-2xl` (24px)
  * `text-4xl` (36px)

### Borders
* **Directional borders are NOT supported in utility classes.** Do NOT use `border-t`, `border-b`, `border-l`, or `border-r`.
* **Only full-border wrappers are allowed:** `border`, `border-2`, `border-4`, `border-8`, or arbitrary `border-[N]`.
* **Implementing single-sided borders:** Render a separate thin `<View>` element to act as a divider line:
  ```tsx
  {/* Horizontal top border separator */}
  <View class="absolute" style={{ insetT: 0, insetL: 0, width: 480, height: 2, bgColor: "#38bdf826" }} />
  ```

### Rounded Corners
* **`rounded-full` needs build-time known size.** You MUST specify both `w-N` and `h-N` in the *same* class literal:
  ```tsx
  {/* Correct */}
  <View class="absolute w-[600] h-[600] rounded-full bg-gradient-to-b ..." />

  {/* Incorrect (w/h in dynamic style object instead of class) */}
  <View class="absolute rounded-full" style={{ width: 600, height: 600 }} />
  ```

---

## 2. Style Object Rules (Runtime Dynamic Styles)

The dynamic `style` object is parsed at runtime. Keys are matched against the native spec enum (`spec/spec.ts`).

### Positioning Offsets
* **Standard CSS directional keys are NOT supported.** Use their spec-compliant equivalents:
  * `left` → **`insetL`**
  * `right` → **`insetR`**
  * `top` → **`insetT`**
  * `bottom` → **`insetB`**

### Visual & Layout Keys
* **Use spec-compliant camelCase style keys:**
  * `background-color` → **`bgColor`**
  * `border-radius` → **`radius`**
  * `border-color` → **`borderColor`**
  * `border-width` → **`borderWidth`**
  * `z-index` → **`zIndex`**
* **Unsupported Keys:** Properties like `font-size`, `font-family`, and `box-shadow` are unrecognized. 

### Values and Units
* **All sizes and dimensions must be raw numbers (representing pixels).** Suffixes like `"px"` are not supported:
  ```tsx
  {/* Correct */}
  style={{ width: 320, height: 220, insetL: 50 }}

  {/* Incorrect */}
  style={{ width: "320px", height: "220px", insetL: "50px" }}
  ```
* **Colors must be `#rrggbbaa` hex strings.** Standard browser color syntaxes (`rgb()`, `rgba()`) are not supported:
  ```tsx
  {/* Correct */}
  style={{ bgColor: "#0f172a66" }}

  {/* Helper for dynamic alpha blending */}
  function toHexColor(r: number, g: number, b: number, a: number): string {
    const toHex = (x: number) => {
      const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
      return hex.length === 1 ? "0" + hex : hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(Math.round(a * 255))}`;
  }
  ```

### Dynamic Text Resizing
* Since `fontSize` is not a dynamic runtime property, scale text by setting a standard class size (like `text-2xl`) and modifying the **`scale`** key inside the dynamic `style` object:
  ```tsx
  <Text class="text-2xl font-bold text-white" style={{ scale: 4.0 }} />
  ```
