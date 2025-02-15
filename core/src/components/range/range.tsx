import type { ComponentInterface, EventEmitter } from '@stencil/core';
import { Component, Element, Event, Host, Prop, State, Watch, h } from '@stencil/core';

import { getIonMode } from '../../global/ionic-global';
import type {
  Color,
  Gesture,
  GestureDetail,
  KnobName,
  RangeChangeEventDetail,
  RangeKnobMoveEndEventDetail,
  RangeKnobMoveStartEventDetail,
  RangeValue,
  StyleEventDetail,
} from '../../interface';
import { findClosestIonContent, disableContentScrollY, resetContentScrollY } from '../../utils/content';
import type { Attributes } from '../../utils/helpers';
import { inheritAriaAttributes, clamp, debounceEvent, getAriaLabel, renderHiddenInput } from '../../utils/helpers';
import { printIonWarning } from '../../utils/logging';
import { isRTL } from '../../utils/rtl';
import { createColorClasses, hostContext } from '../../utils/theme';

import type { PinFormatter } from './range-interface';

/**
 * @virtualProp {"ios" | "md"} mode - The mode determines which platform styles to use.
 *
 * @slot start - Content is placed to the left of the range slider in LTR, and to the right in RTL.
 * @slot end - Content is placed to the right of the range slider in LTR, and to the left in RTL.
 *
 * @part tick - An inactive tick mark.
 * @part tick-active - An active tick mark.
 * @part pin - The counter that appears above a knob.
 * @part knob - The handle that is used to drag the range.
 * @part bar - The inactive part of the bar.
 * @part bar-active - The active part of the bar.
 */
@Component({
  tag: 'ion-range',
  styleUrls: {
    ios: 'range.ios.scss',
    md: 'range.md.scss',
  },
  shadow: true,
})
export class Range implements ComponentInterface {
  private rangeId?: string;
  private didLoad = false;
  private noUpdate = false;
  private rect!: ClientRect;
  private hasFocus = false;
  private rangeSlider?: HTMLElement;
  private gesture?: Gesture;
  private inheritedAttributes: Attributes = {};
  private contentEl: HTMLElement | null = null;
  private initialContentScrollY = true;

  @Element() el!: HTMLIonRangeElement;

  @State() private ratioA = 0;
  @State() private ratioB = 0;
  @State() private pressedKnob: KnobName;

  /**
   * The color to use from your application's color palette.
   * Default options are: `"primary"`, `"secondary"`, `"tertiary"`, `"success"`, `"warning"`, `"danger"`, `"light"`, `"medium"`, and `"dark"`.
   * For more information on colors, see [theming](/docs/theming/basics).
   */
  @Prop({ reflect: true }) color?: Color;

  /**
   * How long, in milliseconds, to wait to trigger the
   * `ionChange` event after each change in the range value.
   * This also impacts form bindings such as `ngModel` or `v-model`.
   */
  @Prop() debounce = 0;

  @Watch('debounce')
  protected debounceChanged() {
    this.ionChange = debounceEvent(this.ionChange, this.debounce);
  }

  // TODO: In Ionic Framework v6 this should initialize to this.rangeId like the other form components do.

  /**
   * The name of the control, which is submitted with the form data.
   */
  @Prop() name = '';

  /**
   * Show two knobs.
   */
  @Prop() dualKnobs = false;

  /**
   * Minimum integer value of the range.
   */
  @Prop() min = 0;
  @Watch('min')
  protected minChanged() {
    if (!this.noUpdate) {
      this.updateRatio();
    }
  }

  /**
   * Maximum integer value of the range.
   */
  @Prop() max = 100;
  @Watch('max')
  protected maxChanged() {
    if (!this.noUpdate) {
      this.updateRatio();
    }
  }

  /**
   * If `true`, a pin with integer value is shown when the knob
   * is pressed.
   */
  @Prop() pin = false;

  /**
   * A callback used to format the pin text.
   * By default the pin text is set to `Math.round(value)`.
   */
  @Prop() pinFormatter: PinFormatter = (value: number): number => Math.round(value);

  /**
   * If `true`, the knob snaps to tick marks evenly spaced based
   * on the step property value.
   */
  @Prop() snaps = false;

  /**
   * Specifies the value granularity.
   */
  @Prop() step = 1;

  /**
   * If `true`, tick marks are displayed based on the step value.
   * Only applies when `snaps` is `true`.
   */
  @Prop() ticks = true;

  /**
   * The start position of the range active bar. This feature is only available with a single knob (dualKnobs="false").
   * Valid values are greater than or equal to the min value and less than or equal to the max value.
   */
  @Prop({ mutable: true }) activeBarStart?: number;
  @Watch('activeBarStart')
  protected activeBarStartChanged() {
    const { activeBarStart } = this;
    if (activeBarStart !== undefined) {
      if (activeBarStart > this.max) {
        printIonWarning(
          `Range: The value of activeBarStart (${activeBarStart}) is greater than the max (${this.max}). Valid values are greater than or equal to the min value and less than or equal to the max value.`,
          this.el
        );
        this.activeBarStart = this.max;
      } else if (activeBarStart < this.min) {
        printIonWarning(
          `Range: The value of activeBarStart (${activeBarStart}) is less than the min (${this.min}). Valid values are greater than or equal to the min value and less than or equal to the max value.`,
          this.el
        );
        this.activeBarStart = this.min;
      }
    }
  }

  /**
   * If `true`, the user cannot interact with the range.
   */
  @Prop() disabled = false;
  @Watch('disabled')
  protected disabledChanged() {
    if (this.gesture) {
      this.gesture.enable(!this.disabled);
    }
    this.emitStyle();
  }

  /**
   * the value of the range.
   */
  @Prop({ mutable: true }) value: RangeValue = 0;
  @Watch('value')
  protected valueChanged(value: RangeValue) {
    if (!this.noUpdate) {
      this.updateRatio();
    }

    value = this.ensureValueInBounds(value);

    this.ionChange.emit({ value });
  }

  private clampBounds = (value: any): number => {
    return clamp(this.min, value, this.max);
  };

  private ensureValueInBounds = (value: any) => {
    if (this.dualKnobs) {
      return {
        lower: this.clampBounds(value.lower),
        upper: this.clampBounds(value.upper),
      };
    } else {
      return this.clampBounds(value);
    }
  };

  /**
   * Emitted when the value property has changed.
   */
  @Event() ionChange!: EventEmitter<RangeChangeEventDetail>;

  /**
   * Emitted when the styles change.
   * @internal
   */
  @Event() ionStyle!: EventEmitter<StyleEventDetail>;

  /**
   * Emitted when the range has focus.
   */
  @Event() ionFocus!: EventEmitter<void>;

  /**
   * Emitted when the range loses focus.
   */
  @Event() ionBlur!: EventEmitter<void>;

  /**
   * Emitted when the user starts moving the range knob, whether through
   * mouse drag, touch gesture, or keyboard interaction.
   */
  @Event() ionKnobMoveStart!: EventEmitter<RangeKnobMoveStartEventDetail>;

  /**
   * Emitted when the user finishes moving the range knob, whether through
   * mouse drag, touch gesture, or keyboard interaction.
   */
  @Event() ionKnobMoveEnd!: EventEmitter<RangeKnobMoveEndEventDetail>;

  private setupGesture = async () => {
    const rangeSlider = this.rangeSlider;
    if (rangeSlider) {
      this.gesture = (await import('../../utils/gesture')).createGesture({
        el: rangeSlider,
        gestureName: 'range',
        gesturePriority: 100,
        threshold: 0,
        onStart: (ev) => this.onStart(ev),
        onMove: (ev) => this.onMove(ev),
        onEnd: (ev) => this.onEnd(ev),
      });
      this.gesture.enable(!this.disabled);
    }
  };

  componentWillLoad() {
    /**
     * If user has custom ID set then we should
     * not assign the default incrementing ID.
     */
    this.rangeId = this.el.hasAttribute('id') ? this.el.getAttribute('id')! : `ion-r-${rangeIds++}`;

    this.inheritedAttributes = inheritAriaAttributes(this.el);
  }

  componentDidLoad() {
    this.setupGesture();
    this.didLoad = true;
  }

  connectedCallback() {
    this.updateRatio();
    this.debounceChanged();
    this.disabledChanged();
    this.activeBarStartChanged();

    /**
     * If we have not yet rendered
     * ion-range, then rangeSlider is not defined.
     * But if we are moving ion-range via appendChild,
     * then rangeSlider will be defined.
     */
    if (this.didLoad) {
      this.setupGesture();
    }

    this.contentEl = findClosestIonContent(this.el);
  }

  disconnectedCallback() {
    if (this.gesture) {
      this.gesture.destroy();
      this.gesture = undefined;
    }
  }

  private handleKeyboard = (knob: KnobName, isIncrease: boolean) => {
    const { ensureValueInBounds } = this;

    let step = this.step;
    step = step > 0 ? step : 1;
    step = step / (this.max - this.min);
    if (!isIncrease) {
      step *= -1;
    }
    if (knob === 'A') {
      this.ratioA = clamp(0, this.ratioA + step, 1);
    } else {
      this.ratioB = clamp(0, this.ratioB + step, 1);
    }

    this.ionKnobMoveStart.emit({ value: ensureValueInBounds(this.value) });
    this.updateValue();
    this.ionKnobMoveEnd.emit({ value: ensureValueInBounds(this.value) });
  };
  private getValue(): RangeValue {
    const value = this.value ?? 0;
    if (this.dualKnobs) {
      if (typeof value === 'object') {
        return value;
      }
      return {
        lower: 0,
        upper: value,
      };
    } else {
      if (typeof value === 'object') {
        return value.upper;
      }
      return value;
    }
  }

  private emitStyle() {
    this.ionStyle.emit({
      interactive: true,
      'interactive-disabled': this.disabled,
    });
  }

  private onStart(detail: GestureDetail) {
    const { contentEl } = this;
    if (contentEl) {
      this.initialContentScrollY = disableContentScrollY(contentEl);
    }

    const rect = (this.rect = this.rangeSlider!.getBoundingClientRect() as any);
    const currentX = detail.currentX;

    // figure out which knob they started closer to
    let ratio = clamp(0, (currentX - rect.left) / rect.width, 1);
    if (isRTL(this.el)) {
      ratio = 1 - ratio;
    }

    this.pressedKnob = !this.dualKnobs || Math.abs(this.ratioA - ratio) < Math.abs(this.ratioB - ratio) ? 'A' : 'B';

    this.setFocus(this.pressedKnob);

    // update the active knob's position
    this.update(currentX);

    this.ionKnobMoveStart.emit({ value: this.ensureValueInBounds(this.value) });
  }

  private onMove(detail: GestureDetail) {
    this.update(detail.currentX);
  }

  private onEnd(detail: GestureDetail) {
    const { contentEl, initialContentScrollY } = this;
    if (contentEl) {
      resetContentScrollY(contentEl, initialContentScrollY);
    }

    this.update(detail.currentX);
    this.pressedKnob = undefined;

    this.ionKnobMoveEnd.emit({ value: this.ensureValueInBounds(this.value) });
  }

  private update(currentX: number) {
    // figure out where the pointer is currently at
    // update the knob being interacted with
    const rect = this.rect;
    let ratio = clamp(0, (currentX - rect.left) / rect.width, 1);
    if (isRTL(this.el)) {
      ratio = 1 - ratio;
    }

    if (this.snaps) {
      // snaps the ratio to the current value
      ratio = valueToRatio(ratioToValue(ratio, this.min, this.max, this.step), this.min, this.max);
    }

    // update which knob is pressed
    if (this.pressedKnob === 'A') {
      this.ratioA = ratio;
    } else {
      this.ratioB = ratio;
    }

    // Update input value
    this.updateValue();
  }

  private get valA() {
    return ratioToValue(this.ratioA, this.min, this.max, this.step);
  }

  private get valB() {
    return ratioToValue(this.ratioB, this.min, this.max, this.step);
  }

  private get ratioLower() {
    if (this.dualKnobs) {
      return Math.min(this.ratioA, this.ratioB);
    }
    const { activeBarStart } = this;
    if (activeBarStart == null) {
      return 0;
    }
    return valueToRatio(activeBarStart, this.min, this.max);
  }

  private get ratioUpper() {
    if (this.dualKnobs) {
      return Math.max(this.ratioA, this.ratioB);
    }
    return this.ratioA;
  }

  private updateRatio() {
    const value = this.getValue() as any;
    const { min, max } = this;
    if (this.dualKnobs) {
      this.ratioA = valueToRatio(value.lower, min, max);
      this.ratioB = valueToRatio(value.upper, min, max);
    } else {
      this.ratioA = valueToRatio(value, min, max);
    }
  }

  private updateValue() {
    this.noUpdate = true;

    const { valA, valB } = this;
    this.value = !this.dualKnobs
      ? valA
      : {
          lower: Math.min(valA, valB),
          upper: Math.max(valA, valB),
        };

    this.noUpdate = false;
  }

  private setFocus(knob: KnobName) {
    if (this.el.shadowRoot) {
      const knobEl = this.el.shadowRoot.querySelector(knob === 'A' ? '.range-knob-a' : '.range-knob-b') as
        | HTMLElement
        | undefined;
      if (knobEl) {
        knobEl.focus();
      }
    }
  }

  private onBlur = () => {
    if (this.hasFocus) {
      this.hasFocus = false;
      this.ionBlur.emit();
      this.emitStyle();
    }
  };

  private onFocus = () => {
    if (!this.hasFocus) {
      this.hasFocus = true;
      this.ionFocus.emit();
      this.emitStyle();
    }
  };

  render() {
    const {
      min,
      max,
      step,
      el,
      handleKeyboard,
      pressedKnob,
      disabled,
      pin,
      ratioLower,
      ratioUpper,
      inheritedAttributes,
      rangeId,
      pinFormatter,
    } = this;

    /**
     * Look for external label, ion-label, or aria-labelledby.
     * If none, see if user placed an aria-label on the host
     * and use that instead.
     */
    let { labelText } = getAriaLabel(el, rangeId!);
    if (labelText === undefined || labelText === null) {
      labelText = inheritedAttributes['aria-label'];
    }
    const mode = getIonMode(this);
    let barStart = `${ratioLower * 100}%`;
    let barEnd = `${100 - ratioUpper * 100}%`;

    const rtl = isRTL(this.el);

    const start = rtl ? 'right' : 'left';
    const end = rtl ? 'left' : 'right';

    const tickStyle = (tick: any) => {
      return {
        [start]: tick[start],
      };
    };

    if (this.dualKnobs === false) {
      /**
       * When the value is less than the activeBarStart or the min value,
       * the knob will display at the start of the active bar.
       */
      if (this.valA < (this.activeBarStart ?? this.min)) {
        /**
         * Sets the bar positions relative to the upper and lower limits.
         * Converts the ratio values into percentages, used as offsets for left/right styles.
         *
         * The ratioUpper refers to the knob position on the bar.
         * The ratioLower refers to the end position of the active bar (the value).
         */
        barStart = `${ratioUpper * 100}%`;
        barEnd = `${100 - ratioLower * 100}%`;
      } else {
        /**
         * Otherwise, the knob will display at the end of the active bar.
         *
         * The ratioLower refers to the start position of the active bar (the value).
         * The ratioUpper refers to the knob position on the bar.
         */
        barStart = `${ratioLower * 100}%`;
        barEnd = `${100 - ratioUpper * 100}%`;
      }
    }

    const barStyle = {
      [start]: barStart,
      [end]: barEnd,
    };

    const ticks = [];
    if (this.snaps && this.ticks) {
      for (let value = min; value <= max; value += step) {
        const ratio = valueToRatio(value, min, max);

        const ratioMin = Math.min(ratioLower, ratioUpper);
        const ratioMax = Math.max(ratioLower, ratioUpper);

        const tick: any = {
          ratio,
          /**
           * Sets the tick mark as active when the tick is between the min bounds and the knob.
           * When using activeBarStart, the tick mark will be active between the knob and activeBarStart.
           */
          active: ratio >= ratioMin && ratio <= ratioMax,
        };

        tick[start] = `${ratio * 100}%`;

        ticks.push(tick);
      }
    }

    renderHiddenInput(true, el, this.name, JSON.stringify(this.getValue()), disabled);

    return (
      <Host
        onFocusin={this.onFocus}
        onFocusout={this.onBlur}
        id={rangeId}
        class={createColorClasses(this.color, {
          [mode]: true,
          'in-item': hostContext('ion-item', el),
          'range-disabled': disabled,
          'range-pressed': pressedKnob !== undefined,
          'range-has-pin': pin,
        })}
      >
        <slot name="start"></slot>
        <div class="range-slider" ref={(rangeEl) => (this.rangeSlider = rangeEl)}>
          {ticks.map((tick) => (
            <div
              style={tickStyle(tick)}
              role="presentation"
              class={{
                'range-tick': true,
                'range-tick-active': tick.active,
              }}
              part={tick.active ? 'tick-active' : 'tick'}
            />
          ))}

          <div class="range-bar" role="presentation" part="bar" />
          <div class="range-bar range-bar-active" role="presentation" style={barStyle} part="bar-active" />

          {renderKnob(rtl, {
            knob: 'A',
            pressed: pressedKnob === 'A',
            value: this.valA,
            ratio: this.ratioA,
            pin,
            pinFormatter,
            disabled,
            handleKeyboard,
            min,
            max,
            labelText,
          })}

          {this.dualKnobs &&
            renderKnob(rtl, {
              knob: 'B',
              pressed: pressedKnob === 'B',
              value: this.valB,
              ratio: this.ratioB,
              pin,
              pinFormatter,
              disabled,
              handleKeyboard,
              min,
              max,
              labelText,
            })}
        </div>
        <slot name="end"></slot>
      </Host>
    );
  }
}

interface RangeKnob {
  knob: KnobName;
  value: number;
  ratio: number;
  min: number;
  max: number;
  disabled: boolean;
  pressed: boolean;
  pin: boolean;
  pinFormatter: PinFormatter;
  labelText?: string | null;

  handleKeyboard: (name: KnobName, isIncrease: boolean) => void;
}

const renderKnob = (
  rtl: boolean,
  { knob, value, ratio, min, max, disabled, pressed, pin, handleKeyboard, labelText, pinFormatter }: RangeKnob
) => {
  const start = rtl ? 'right' : 'left';

  const knobStyle = () => {
    const style: any = {};

    style[start] = `${ratio * 100}%`;

    return style;
  };

  return (
    <div
      onKeyDown={(ev: KeyboardEvent) => {
        const key = ev.key;
        if (key === 'ArrowLeft' || key === 'ArrowDown') {
          handleKeyboard(knob, false);
          ev.preventDefault();
          ev.stopPropagation();
        } else if (key === 'ArrowRight' || key === 'ArrowUp') {
          handleKeyboard(knob, true);
          ev.preventDefault();
          ev.stopPropagation();
        }
      }}
      class={{
        'range-knob-handle': true,
        'range-knob-a': knob === 'A',
        'range-knob-b': knob === 'B',
        'range-knob-pressed': pressed,
        'range-knob-min': value === min,
        'range-knob-max': value === max,
        'ion-activatable': true,
        'ion-focusable': true,
      }}
      style={knobStyle()}
      role="slider"
      tabindex={disabled ? -1 : 0}
      aria-label={labelText}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-disabled={disabled ? 'true' : null}
      aria-valuenow={value}
    >
      {pin && (
        <div class="range-pin" role="presentation" part="pin">
          {pinFormatter(value)}
        </div>
      )}
      <div class="range-knob" role="presentation" part="knob" />
    </div>
  );
};

const ratioToValue = (ratio: number, min: number, max: number, step: number): number => {
  let value = (max - min) * ratio;
  if (step > 0) {
    value = Math.round(value / step) * step + min;
  }
  return clamp(min, value, max);
};

const valueToRatio = (value: number, min: number, max: number): number => {
  return clamp(0, (value - min) / (max - min), 1);
};

let rangeIds = 0;
