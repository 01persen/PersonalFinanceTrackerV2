"use client";

import type { ChangeEvent } from "react";

import {
  EF_MULTIPLIER_MAX,
  EF_MULTIPLIER_MIN,
  LOCKED_CURRENCY,
  LOCKED_LOCALE,
  WEEK_START_LABEL,
  WEEK_START_VALUES,
  type Settings,
  type SettingsFormErrors,
} from "@/lib/api/settings-client";
import {
  ACKNOWLEDGED_SETTINGS_FIELDS,
  type SettingsFormValues,
} from "@/components/settings/settings-form-state";

/* -------------------------------------------------------------------------- *
 * Form skeleton                                                               *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the loading-state rendering used by the goal / account /
 * transaction form layers: a same-shape stack of empty inputs +
 * labels + a disabled Save button so the layout doesn't shift when
 * the real data arrives. The page wrapper toggles between this
 * skeleton and the live form based on the `loading` prefetch state.
 */

export function SettingsFormSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <section className="grid gap-4" aria-label="Profil">
        <div className="h-3 w-32 animate-pulse rounded bg-slate-200" />
        <div className="grid gap-2">
          <div className="h-3 w-16 animate-pulse rounded bg-slate-200" />
          <div className="h-10 w-full animate-pulse rounded-md bg-slate-100" />
        </div>
        <div className="grid gap-2">
          <div className="h-3 w-24 animate-pulse rounded bg-slate-200" />
          <div className="h-10 w-full animate-pulse rounded-md bg-slate-100" />
        </div>
      </section>

      <section className="grid gap-4" aria-label="Preferensi">
        <div className="h-3 w-36 animate-pulse rounded bg-slate-200" />
        <div className="grid gap-2">
          <div className="h-3 w-16 animate-pulse rounded bg-slate-200" />
          <div className="h-10 w-full animate-pulse rounded-md bg-slate-100" />
        </div>
        <div className="grid gap-2">
          <div className="h-3 w-20 animate-pulse rounded bg-slate-200" />
          <div className="h-10 w-full animate-pulse rounded-md bg-slate-100" />
        </div>
        <div className="grid gap-2">
          <div className="h-3 w-40 animate-pulse rounded bg-slate-200" />
          <div className="h-24 w-full animate-pulse rounded-md bg-slate-100" />
        </div>
        <div className="grid gap-2">
          <div className="h-3 w-24 animate-pulse rounded bg-slate-200" />
          <div className="h-10 w-full animate-pulse rounded-md bg-slate-100" />
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Form fields                                                                 *
 * -------------------------------------------------------------------------- *
 *
 * Pure presentational component — receives the live values + errors
 * via props and emits the new value via `onChange`. The page wrapper
 * owns the dirty-check + optimistic-update + rollback state machine
 * so this component stays trivially testable.
 *
 * Layout is mobile-first (390×844 reference width, PRD §15):
 * stacked sections, single-column inputs, ≥44px touch target via
 * the `form-input` class + the radio/checkbox sizing below.
 */

interface SettingsFormFieldsProps {
  values: SettingsFormValues;
  errors: SettingsFormErrors;
  onChange: (next: SettingsFormValues) => void;
  settings: Settings;
  disabled?: boolean;
  idPrefix?: string;
}

export function SettingsFormFields({
  values,
  errors,
  onChange,
  settings,
  disabled,
  idPrefix = "settings",
}: SettingsFormFieldsProps) {
  const handleDisplayNameChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...values, displayName: event.target.value });
  };

  const handleMultiplierChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...values, efMultiplier: event.target.value });
  };

  const handleWeekStartChange = (next: Settings["weekStart"]) => {
    onChange({ ...values, weekStart: next });
  };

  return (
    <div className="grid gap-6">
      {/* -------- Profil -------- */}
      <section
        aria-labelledby={`${idPrefix}-profile-heading`}
        className="grid gap-4"
      >
        <header className="grid gap-1">
          <h3
            id={`${idPrefix}-profile-heading`}
            className="text-base font-semibold text-slate-900"
          >
            Profil
          </h3>
          <p className="text-xs text-slate-500">
            Nama tampilan muncul di header aplikasi. Email tidak bisa
            diubah dari halaman ini.
          </p>
        </header>

        <div className="grid gap-1">
          <label
            htmlFor={`${idPrefix}-email`}
            className="form-label"
          >
            Email
          </label>
          <input
            id={`${idPrefix}-email`}
            type="email"
            value={settings.email}
            readOnly
            aria-readonly="true"
            disabled
            className="form-input cursor-not-allowed bg-slate-100 text-slate-500"
          />
          <p className="mt-1 text-xs text-slate-500">
            Email terhubung ke akun kamu dan hanya bisa diubah lewat
            alur ubah email (di luar MVP).
          </p>
        </div>

        <div className="grid gap-1">
          <label
            htmlFor={`${idPrefix}-display-name`}
            className="form-label"
          >
            Nama tampilan
          </label>
          <input
            id={`${idPrefix}-display-name`}
            type="text"
            value={values.displayName}
            onChange={handleDisplayNameChange}
            disabled={disabled}
            maxLength={ACKNOWLEDGED_SETTINGS_FIELDS.displayNameMax}
            placeholder="Contoh: Budi P."
            autoComplete="off"
            className="form-input"
            aria-invalid={errors.displayName ? "true" : undefined}
            aria-describedby={
              errors.displayName
                ? `${idPrefix}-display-name-error`
                : `${idPrefix}-display-name-hint`
            }
          />
          {errors.displayName ? (
            <p
              id={`${idPrefix}-display-name-error`}
              role="alert"
              className="form-error"
            >
              {errors.displayName}
            </p>
          ) : (
            <p
              id={`${idPrefix}-display-name-hint`}
              className="mt-1 text-xs text-slate-500"
            >
              Opsional. Kosongkan untuk menghapus nama tampilan.
              Maksimal {ACKNOWLEDGED_SETTINGS_FIELDS.displayNameMax}{" "}
              karakter.
            </p>
          )}
        </div>
      </section>

      {/* -------- Preferensi -------- */}
      <section
        aria-labelledby={`${idPrefix}-preferences-heading`}
        className="grid gap-4"
      >
        <header className="grid gap-1">
          <h3
            id={`${idPrefix}-preferences-heading`}
            className="text-base font-semibold text-slate-900"
          >
            Preferensi
          </h3>
          <p className="text-xs text-slate-500">
            MVP menggunakan satu mata uang (IDR) dan satu locale
            (id-ID). Hari pertama minggu memengaruhi kalender widget
            dan tampilan mingguan. Multiplier dana darurat dipakai
            oleh goal engine untuk menghitung snapshot dana darurat.
          </p>
        </header>

        <div className="grid gap-1">
          <label
            htmlFor={`${idPrefix}-currency`}
            className="form-label"
          >
            Mata uang
          </label>
          <input
            id={`${idPrefix}-currency`}
            type="text"
            value={LOCKED_CURRENCY}
            readOnly
            aria-readonly="true"
            disabled
            className="form-input cursor-not-allowed bg-slate-100 text-slate-500"
          />
          <p className="mt-1 text-xs text-slate-500">
            Terkunci ke IDR (PRD §3 — MVP single-currency).
          </p>
        </div>

        <div className="grid gap-1">
          <label
            htmlFor={`${idPrefix}-locale`}
            className="form-label"
          >
            Locale
          </label>
          <input
            id={`${idPrefix}-locale`}
            type="text"
            value={LOCKED_LOCALE}
            readOnly
            aria-readonly="true"
            disabled
            className="form-input cursor-not-allowed bg-slate-100 text-slate-500"
          />
          <p className="mt-1 text-xs text-slate-500">
            Terkunci ke id-ID (PRD §3 — MVP Indonesian-only).
          </p>
        </div>

        <fieldset className="grid gap-2">
          <legend className="form-label">Hari pertama minggu</legend>
          <div
            role="radiogroup"
            aria-labelledby={`${idPrefix}-week-start-legend`}
            className="grid gap-2 sm:grid-cols-2"
          >
            <span id={`${idPrefix}-week-start-legend`} className="sr-only">
              Hari pertama minggu
            </span>
            {WEEK_START_VALUES.map((value) => {
              const id = `${idPrefix}-week-start-${value}`;
              const checked = values.weekStart === value;
              return (
                <label
                  key={value}
                  htmlFor={id}
                  className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition ${
                    checked
                      ? "border-brand-500 bg-brand-50 text-brand-900"
                      : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                  } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
                >
                  <input
                    id={id}
                    type="radio"
                    name={`${idPrefix}-week-start`}
                    value={value}
                    checked={checked}
                    onChange={() => handleWeekStartChange(value)}
                    disabled={disabled}
                    className="h-4 w-4 cursor-pointer accent-brand-600"
                  />
                  <span>{WEEK_START_LABEL[value]}</span>
                </label>
              );
            })}
          </div>
          {errors.weekStart ? (
            <p role="alert" className="form-error">
              {errors.weekStart}
            </p>
          ) : null}
        </fieldset>

        <div className="grid gap-1">
          <label
            htmlFor={`${idPrefix}-ef-multiplier`}
            className="form-label"
          >
            Multiplier dana darurat
          </label>
          <input
            id={`${idPrefix}-ef-multiplier`}
            type="number"
            inputMode="numeric"
            min={EF_MULTIPLIER_MIN}
            max={EF_MULTIPLIER_MAX}
            step={1}
            value={values.efMultiplier}
            onChange={handleMultiplierChange}
            disabled={disabled}
            className="form-input"
            aria-invalid={errors.efMultiplier ? "true" : undefined}
            aria-describedby={
              errors.efMultiplier
                ? `${idPrefix}-ef-multiplier-error`
                : `${idPrefix}-ef-multiplier-hint`
            }
          />
          {errors.efMultiplier ? (
            <p
              id={`${idPrefix}-ef-multiplier-error`}
              role="alert"
              className="form-error"
            >
              {errors.efMultiplier}
            </p>
          ) : (
            <p
              id={`${idPrefix}-ef-multiplier-hint`}
              className="mt-1 text-xs text-slate-500"
            >
              Bilangan bulat {EF_MULTIPLIER_MIN}–{EF_MULTIPLIER_MAX}.
              Snapshot dana darurat = biaya bulanan × jumlah tanggungan
              × multiplier (sub-0005-02). Default seed: 3.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}