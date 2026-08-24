'use client';

import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';

export function RadioGroup({
  label,
  options,
  value,
  onValueChange,
}: {
  readonly label: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly description: string;
  }[];
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}) {
  return (
    <RadioGroupPrimitive.Root
      aria-label={label}
      className="radio-group"
      onValueChange={onValueChange}
      value={value}
    >
      {options.map((option) => (
        <label className="radio-card" key={option.value}>
          <RadioGroupPrimitive.Item
            aria-label={option.label}
            className="radio-item"
            value={option.value}
          >
            <RadioGroupPrimitive.Indicator className="radio-indicator" />
          </RadioGroupPrimitive.Item>
          <span>
            <strong>{option.label}</strong>
            <small>{option.description}</small>
          </span>
        </label>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
