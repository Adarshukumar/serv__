import sys, os, asyncio, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from app.main import ProviderManager

async def _test_load_impl(n=20):
    mgr = ProviderManager()
    async def single(i):
        t0 = time.time()
        chars = 0
        try:
            async for ev in mgr.stream(provider="ragsrv", model="luna", data="Hi in one word", user_ip=f"1.2.3.{i%255}"):
                if ev.kind == "content":
                    chars += len(ev.text)
            ok = chars>0
        except Exception as e:
            print(f"single {i} failed {e}")
            ok = False
            chars = 0
        return {"ok": ok, "elapsed": time.time()-t0, "chars": chars}

    t0 = time.time()
    results = await asyncio.gather(*[single(i) for i in range(n)])
    total = time.time()-t0
    ok = sum(1 for r in results if r["ok"])
    avg = sum(r["elapsed"] for r in results)/n if n else 0
    print(f"Load {n}: ok={ok}/{n} total={total:.2f}s avg={avg:.3f}s throughput={n/total:.2f} users/s")
    assert ok >= n*0.9, f"Too many failures {ok}/{n}"
    assert total < 15, f"Too slow total {total}s"
    return ok

async def _test_fallback_impl():
    mgr = ProviderManager()
    chars = 0
    async for ev in mgr.stream(provider="bad-provider", model="luna", data="Hello", user_ip="1.2.3.4"):
        if ev.kind == "content":
            chars += len(ev.text)
    assert chars > 0, "Fallback to ragsrv failed"
    print("Fallback OK")

@pytest.mark.asyncio
async def test_load():
    await _test_load_impl(10)
    await _test_load_impl(20)

@pytest.mark.asyncio
async def test_fallback():
    await _test_fallback_impl()

async def main():
    await _test_load_impl(10)
    await _test_load_impl(20)
    await _test_fallback_impl()
    print("test_load OK")

if __name__ == "__main__":
    asyncio.run(main())
