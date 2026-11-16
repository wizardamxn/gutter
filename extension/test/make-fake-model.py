"""Rebuilds test/fake-model: a tiny stand-in for the embedding model, used only by e2e.mjs.

It is NOT the real model. Money words point one way, everything else another, which is
enough to prove the whole pipeline runs inside the extension. Needs: pip install onnx numpy
Run from extension/:  python3 test/make-fake-model.py
"""
import json, os
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

root = 'test/fake-model/Xenova/all-MiniLM-L6-v2'
os.makedirs(root + '/onnx', exist_ok=True)
money = ['cost', 'price', 'euros', 'dollars', 'budget']
vocab = {'[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3}
for w in money:
    vocab[w] = len(vocab)
table = np.zeros((len(vocab), 4), dtype=np.float32)
table[:, 1] = 1.0
table[0] = 0
for w in money:
    table[vocab[w]] = [8, 0, 0, 0]

graph = helper.make_graph(
    [helper.make_node('Gather', ['table', 'input_ids'], ['last_hidden_state'], axis=0)],
    'fake-minilm',
    [helper.make_tensor_value_info('input_ids', TensorProto.INT64, ['batch', 'seq']),
     helper.make_tensor_value_info('attention_mask', TensorProto.INT64, ['batch', 'seq'])],
    [helper.make_tensor_value_info('last_hidden_state', TensorProto.FLOAT, ['batch', 'seq', 4])],
    [numpy_helper.from_array(table, 'table')])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, root + '/onnx/model_quantized.onnx')
print('wrote', root, '(config.json, tokenizer.json and tokenizer_config.json are kept in the repo)')
