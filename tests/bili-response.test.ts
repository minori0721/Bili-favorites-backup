import assert from "node:assert/strict";
import test from "node:test";
import {
  BiliFavoriteFolderResponseError,
  normalizeFavoriteFolderListResponse,
} from "../src/bili.js";

test("收藏夹列表响应必须包含数组，否则返回可读的接口异常", () => {
  assert.deepEqual(normalizeFavoriteFolderListResponse({ list: [{ id: 1 }] }), [{ id: 1 }]);
  assert.throws(
    () => normalizeFavoriteFolderListResponse(null),
    (error) => error instanceof BiliFavoriteFolderResponseError
      && error.message.includes("收藏夹接口返回异常"),
  );
  assert.throws(() => normalizeFavoriteFolderListResponse({ list: null }), BiliFavoriteFolderResponseError);
});
