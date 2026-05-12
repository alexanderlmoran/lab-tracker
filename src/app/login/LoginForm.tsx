"use client";

import { useRef, useState, useTransition } from "react";
import { forgotPasswordAction, loginAction } from "./actions";

export function LoginForm({
  next,
  initialError,
}: {
  next?: string;
  initialError?: string;
}) {
  const emailRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [resetNote, setResetNote] = useState<string | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(formData: FormData) {
    setError(null);
    setResetNote(null);
    startTransition(async () => {
      const result = await loginAction(formData);
      if (result && !result.ok) setError(result.error);
    });
  }

  function onForgot() {
    setError(null);
    setResetNote(null);
    const email = emailRef.current?.value?.trim();
    if (!email) {
      setError("Type your email above first, then click Forgot password.");
      return;
    }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("email", email);
      const res = await forgotPasswordAction(fd);
      if (res.ok) {
        setResetNote(res.note);
        setForgotOpen(false);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div>
        <label
          htmlFor="email"
          className="block text-xs font-medium text-zinc-700"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          ref={emailRef}
          required
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10"
        />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <label
            htmlFor="password"
            className="block text-xs font-medium text-zinc-700"
          >
            Password
          </label>
          <button
            type="button"
            onClick={() => {
              setForgotOpen((v) => !v);
              setResetNote(null);
              setError(null);
            }}
            className="text-[11px] font-medium text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
          >
            Forgot password?
          </button>
        </div>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10"
        />
      </div>

      {forgotOpen ? (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <p className="text-xs text-zinc-600">
            Enter your email above, then click below. We'll send a link to
            reset your password.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={onForgot}
            className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
          >
            {pending ? "Sending…" : "Send reset link"}
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {resetNote ? (
        <p className="text-sm text-emerald-700">{resetNote}</p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
