export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <section aria-labelledby="login-title" className="auth-card">
      <p className="eyebrow">Single operator</p>
      <h1 id="login-title">Sign in to Agent OS</h1>
      <p>Continue with the GitHub account authorized for this control plane.</p>
      {error ? (
        <p className="notice error" role="alert" tabIndex={-1}>
          GitHub sign-in could not be completed. Please try again.
        </p>
      ) : null}
      <a className="button" href="/auth/github">
        Continue with GitHub
      </a>
    </section>
  );
}
