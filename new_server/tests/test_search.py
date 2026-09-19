import sys, os, asyncio
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from app.core.search import NativeSearch, global_search

@pytest.mark.asyncio
async def test_empty():
    s = NativeSearch()
    res = await s.search("", max_results=3)
    assert res == []

@pytest.mark.asyncio
async def test_cache():
    s = NativeSearch()
    q = "test cache query unique 12345"
    key = __import__("hashlib").sha256(q.lower().strip().encode()).hexdigest()
    s._cache[key] = (9999999999, [])  # far future ts, empty results
    res = await s.search(q, max_results=2)
    assert res == []
    assert s._stats["hits"] >= 1

def test_stats():
    s = NativeSearch()
    stats = s.get_stats_sync()
    assert "hits" in stats
    assert "hit_rate" in stats

@pytest.mark.asyncio
async def test_global():
    # Global singleton
    stats = global_search.get_stats_sync()
    assert isinstance(stats, dict)

async def main():
    await test_empty()
    await test_cache()
    test_stats()
    await test_global()
    print("test_search OK")

if __name__ == "__main__":
    asyncio.run(main())
