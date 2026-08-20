import { requireUser } from "@/lib/auth";
import { SidebarNav } from "@/components/sidebar-nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser();

  return (
    <div className="flex min-h-screen">
      <SidebarNav email={user.email ?? ""} />
      <main className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}
