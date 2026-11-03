import { Link } from "react-router";

export default function NotFound() {
  return (
    <div className="py-24 text-center">
      <h1 className="font-display text-4xl font-bold">页面不存在</h1>
      <p className="text-muted-foreground mt-3">这个地址没有对应的页面。</p>
      <Link to="/" className="inline-block mt-6 text-primary underline underline-offset-4">
        回到首页
      </Link>
    </div>
  );
}
