// src/ui/app-rail-sign-out.tsx
export function AppRailSignOut() {
  return (
    <form action="/auth/logout" className="rail-sign-out" method="post">
      <button type="submit">Sign Out</button>
    </form>
  );
}
