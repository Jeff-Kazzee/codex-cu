# Windows interaction reference

The examples below use the documented `@oai/sky` window API. The installed runtime may also return documentation or restrictions. Read those when available and use supported methods only.

## One action with a refresh

After inspecting an accessibility observation, replace the example index with the intended index from that observation:

```javascript
{
  const observed = globalThis.state;
  if (!observed?.accessibility)
    throw new Error('Observe the window before acting');
  const elementIndex = 12;
  globalThis.state = null;
  await sky.click({ window: observed.window, element_index: elementIndex });
  globalThis.state = await sky.get_window_state({
    window: observed.window,
    include_screenshot: true,
    include_text: true,
  });
  globalThis.targetWindow = state.window;
  nodeRepl.write(
    state.accessibility?.tree ?? 'Inspect the refreshed screenshot',
  );
}
```

If either call fails, the input outcome is unknown. Observe again before retrying. Clearing the prior state prevents accidental reuse.

For a coordinate input, first inspect a fresh screenshot. Use its ID, the returned window, and window-relative coordinates:

```javascript
await sky.click({
  window: state.window,
  screenshotId: state.screenshots[0].id,
  x: 420,
  y: 260,
});
```

The numbers above illustrate the call shape. Choose actual coordinates from the observed image. Apply the same state invalidation and immediate refresh as the accessibility example.

## Input methods

Every method targets a returned `window` object. These argument shapes identify the supported controls:

| Method                     | Arguments in addition to `window`                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `click`                    | `element_index`, or `x`, `y`, and a fresh `screenshotId`. Optional `mouse_button` and `click_count`. |
| `type_text`                | `text`, sent literally to the current focus.                                                         |
| `press_key`                | `key`, such as `Return`, `Tab`, or `Control_L+s`.                                                    |
| `set_value`                | `element_index` and `value` for an observed editable element.                                        |
| `scroll`                   | `x`, `y`, `scrollX`, and `scrollY`. Optional fresh `screenshotId`.                                   |
| `drag`                     | `from_x`, `from_y`, `to_x`, and `to_y`. Optional fresh `screenshotId`.                               |
| `perform_secondary_action` | `element_index` and an `action` label returned by the observation.                                   |
| `activate_window`          | No additional arguments. Refresh after activation.                                                   |

Positive `scrollY` scrolls down. Negative values scroll up. Scroll inside the intended pane using observed coordinates. `scroll` does not take `element_index`.

Use X Window System keysym-style names for keyboard input. Use `KP_0` through `KP_9` for number-pad keys. Use explicit modifiers for shifted punctuation. Windows-key shortcuts are outside this workflow.

`get_window_state` returns `window`, `screenshots`, and optional `accessibility`. Accessibility includes `tree`, `focused_element`, `document_text`, and selection fields when available. Request text or screenshots according to the next decision. Request both when focus or verification needs both.

## Discovery and focus

Filter discovery by the intended app and observed title. If multiple windows remain, inspect them or ask for the missing choice. Keep the returned object intact.

For document entry, a foreground process or window title does not establish editor focus. Click the editable document area, refresh, inspect focus, then type in a separate call. Do not embed Enter, Tab, or other control keys in typed text.

Before input, verify that the image contains the intended app. A matching window ID and title cannot establish image content. If another app covers the target and foreground control is authorized, call `activate_window` on the selected returned window, refresh, and inspect the image before continuing. Preserve a background-only requirement by reporting the limitation instead.

If input reports that another window covers the target, activate the returned target and capture fresh screenshot state. Retry the intended input once against that refreshed state. If a dialog owns a separate window, select that returned dialog window through discovery.
