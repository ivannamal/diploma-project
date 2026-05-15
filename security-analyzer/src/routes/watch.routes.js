const express = require('express');
const ctrl = require('../controllers/watch.controller');

const router = express.Router();

router.post('/watch', ctrl.add);
router.get('/watch', ctrl.list);
router.post('/watch/check-now', ctrl.checkNow);
router.delete('/watch/:owner/:repo', ctrl.remove);

module.exports = router;
