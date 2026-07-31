<script setup lang="ts">
import { ref } from 'vue'
import { draggedPaneSize, nudgedPaneSize, type PaneSpec } from '@renderer/shell/paneResizer'

/**
 * A draggable edge between two panes, on either axis.
 *
 * Replaces `UDashboardPanel`'s handle, which could not do this job: its width
 * lives in a composable behind the component with no size event out of it, so
 * there was no way to hold the value in a store — and a value the store cannot
 * hold is a value the router washes away. It also only splits horizontally, and
 * the Artists/Albums divide is vertical.
 *
 * Controlled, not self-owning. The size comes in and goes out, so the caller
 * decides where it is kept, and this component is the same whether that is the
 * shell store, a panel's own store, or a plain ref in a test. The arithmetic is
 * in `paneResizer.ts` for the same reason; what is left here is genuinely just
 * pointer plumbing.
 *
 * Pointer events rather than a mouse pair and a touch pair: one capture keeps
 * the drag attached to the handle when the cursor outruns it, which is the
 * normal case for a fast drag and the one that otherwise strands the pane
 * mid-resize.
 */
const props = withDefaults(
  defineProps<{
    pane: PaneSpec
    /** Current size along the pane's axis, in CSS pixels. */
    size: number
    /** Keyboard step. Shift makes it one pixel, for the last bit of a fit. */
    step?: number
    disabled?: boolean
  }>(),
  { step: 16, disabled: false }
)

/**
 * `dragging` is emitted for the caller's benefit, not this component's.
 *
 * A pane that animates its size — the frame's sidebar does, so it can collapse
 * rather than vanish when a tab wants the full width — must not animate it
 * during a drag, or the edge trails the cursor by the length of the transition
 * and the whole thing feels like it is being towed. The caller is the only one
 * that knows whether it has such a transition to suspend.
 */
const emit = defineEmits<{ 'update:size': [number]; dragging: [boolean] }>()

const handle = ref<HTMLElement | null>(null)
const dragging = ref(false)

/**
 * The container's size along the axis, measured from the handle's parent.
 *
 * Measured once per drag rather than per move: the parent is the flex row or
 * column both panes sit in, and reading its box on every pointermove is a
 * forced layout in the middle of a drag. It cannot change mid-drag anyway
 * without the window being resized at the same time.
 */
function containerPx(): number | undefined {
  const parent = handle.value?.parentElement
  if (!parent) return undefined
  const box = parent.getBoundingClientRect()
  const px = props.pane.axis === 'x' ? box.width : box.height
  return px > 0 ? px : undefined
}

function positionOf(event: PointerEvent): number {
  return props.pane.axis === 'x' ? event.clientX : event.clientY
}

function onPointerdown(event: PointerEvent): void {
  const element = handle.value
  if (props.disabled || event.button !== 0 || !element) return
  event.preventDefault()

  const startPosition = positionOf(event)
  const startSize = props.size
  const container = containerPx()
  dragging.value = true
  emit('dragging', true)
  element.setPointerCapture(event.pointerId)

  const onMove = (moved: PointerEvent): void => {
    emit(
      'update:size',
      draggedPaneSize(props.pane, {
        startSize,
        startPosition,
        position: positionOf(moved),
        containerPx: container
      })
    )
  }

  const onStop = (): void => {
    dragging.value = false
    emit('dragging', false)
    element.removeEventListener('pointermove', onMove)
    element.removeEventListener('pointerup', onStop)
    element.removeEventListener('pointercancel', onStop)
    // Releasing a capture the browser has already dropped throws, which on a
    // cancelled drag would take the frame down for nothing.
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
  }

  element.addEventListener('pointermove', onMove)
  element.addEventListener('pointerup', onStop)
  element.addEventListener('pointercancel', onStop)
}

/**
 * Keyboard resizing, which is what makes a `separator` with a `tabindex` honest
 * rather than a focus stop that does nothing.
 *
 * The arrow that grows the pane is the one pointing away from it, matching the
 * drag: right and down for a pane that sits before its handle, left and up for
 * one that sits after.
 */
function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  const { axis, side, min, defaultSize } = props.pane
  const grow = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
  const shrink = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
  const step = (event.shiftKey ? 1 : props.step) * (side === 'before' ? 1 : -1)

  if (event.key === grow) nudge(step)
  else if (event.key === shrink) nudge(-step)
  else if (event.key === 'Home') emit('update:size', min)
  else if (event.key === 'End') nudge(Number.POSITIVE_INFINITY)
  else if (event.key === 'Enter' || event.key === ' ') emit('update:size', defaultSize)
  else return

  event.preventDefault()
  event.stopPropagation()
}

function nudge(delta: number): void {
  emit('update:size', nudgedPaneSize(props.pane, props.size, delta, containerPx()))
}
</script>

<template>
  <div
    ref="handle"
    role="separator"
    :aria-orientation="pane.axis === 'x' ? 'vertical' : 'horizontal'"
    :aria-label="pane.label"
    :aria-valuenow="Math.round(size)"
    :aria-valuemin="pane.min"
    :aria-valuemax="pane.max"
    :aria-disabled="disabled || undefined"
    :tabindex="disabled ? -1 : 0"
    :data-dragging="dragging || undefined"
    class="pane-resizer relative shrink-0 touch-none bg-border outline-none transition-colors before:absolute before:z-10 before:content-[''] hover:bg-primary/60 focus-visible:bg-primary data-[dragging]:bg-primary"
    :class="
      pane.axis === 'x'
        ? 'w-px cursor-col-resize before:inset-y-0 before:-inset-x-1'
        : 'h-px cursor-row-resize before:inset-x-0 before:-inset-y-1'
    "
    @pointerdown="onPointerdown"
    @keydown="onKeydown"
    @dblclick="emit('update:size', pane.defaultSize)"
  />
</template>

<style scoped>
/*
 * The hairline is one pixel and the target is nine. A pseudo-element rather
 * than padding on the handle itself, because padding would take part in the
 * flex layout and push the panes apart by the size of the grab area — the
 * pseudo-element hit-tests as part of the element while occupying no space in
 * the row.
 */
.pane-resizer[data-dragging] {
  /* A drag that outruns the handle must not leave a text caret behind it. */
  user-select: none;
}

@media (prefers-reduced-motion: reduce) {
  .pane-resizer {
    transition-duration: 0ms;
  }
}
</style>
